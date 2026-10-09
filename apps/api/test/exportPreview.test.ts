import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildExportZip, ExportBlockedError } from '../src/exportZip.js';
import { buildPreviewServer } from '../src/preview.js';

/* ------------------------------------------------------------------ */
/* Export ZIP                                                          */
/* ------------------------------------------------------------------ */

function initRepo(dir: string, files: Record<string, string>) {
  execFileSync('git', ['init', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init']);
}

/** Minimal ZIP parser: validates structure and extracts stored entries. */
function parseZip(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let off = 0;
  const central: Array<{ name: string; localOff: number; size: number }> = [];
  while (off < buf.length - 4) {
    const sig = buf.readUInt32LE(off);
    if (sig === 0x04034b50) {
      const compSize = buf.readUInt32LE(off + 18);
      const nameLen = buf.readUInt16LE(off + 26);
      const extraLen = buf.readUInt16LE(off + 28);
      off += 30 + nameLen + extraLen + compSize;
    } else if (sig === 0x02014b50) {
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
      const localOff = buf.readUInt32LE(off + 42);
      const size = buf.readUInt32LE(off + 24);
      central.push({ name, localOff, size });
      off += 46 + nameLen + extraLen + commentLen;
    } else if (sig === 0x06054b50) {
      break;
    } else {
      throw new Error(`bad zip signature at ${off}`);
    }
  }
  for (const c of central) {
    const nameLen = buf.readUInt16LE(c.localOff + 26);
    const extraLen = buf.readUInt16LE(c.localOff + 28);
    const dataStart = c.localOff + 30 + nameLen + extraLen;
    entries.set(c.name, buf.subarray(dataStart, dataStart + c.size));
  }
  return entries;
}

describe('buildExportZip', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gf-export-'));
    initRepo(dir, {
      'index.html': '<html><body>game</body></html>',
      'src/main.js': 'console.log("hi");',
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('produces a valid ZIP with all committed files + README', () => {
    return buildExportZip(dir, 'My Game', 'arcade-2d').then((zip) => {
      expect(zip.subarray(0, 2).toString()).toBe('PK');
      const entries = parseZip(zip);
      expect(entries.get('index.html')!.toString()).toContain('game');
      expect(entries.get('src/main.js')!.toString()).toContain('hi');
      expect(entries.get('GAMEFORGE_README.md')!.toString()).toContain('My Game');
      expect(entries.get('GAMEFORGE_README.md')!.toString()).toContain('arcade-2d');
    });
  });

  it('refuses the export when a file trips the secret scanner', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'gf-export-secret-'));
    try {
      initRepo(dir2, {
        'index.html': '<html></html>',
        // A Groq-key shape the shared redactor knows.
        'config.js': 'const key = "gsk_abcdefghijklmnopqrstuvwxyz0123456789";',
      });
      await expect(buildExportZip(dir2, 'Leaky', 'empty-three')).rejects.toBeInstanceOf(
        ExportBlockedError,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Preview origin                                                      */
/* ------------------------------------------------------------------ */

describe('buildPreviewServer', () => {
  let storage: string;
  let server: ReturnType<typeof buildPreviewServer>;
  const goodBuild = `build_${'A'.repeat(26)}`;
  const badBuild = `build_${'B'.repeat(26)}`;

  const db = {
    query: async <T>(text: string, params?: unknown[]) => {
      const id = (params ?? [])[0] as string;
      const status = id === goodBuild ? 'verified' : id === badBuild ? 'failed' : null;
      return { rows: (status ? [{ status }] : []) as T[] };
    },
  };

  beforeAll(async () => {
    storage = mkdtempSync(join(tmpdir(), 'gf-preview-'));
    const dist = join(storage, 'artifacts', goodBuild, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html><body>preview</body></html>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    server = buildPreviewServer({
      storageRoot: storage,
      db,
      studioOrigin: 'https://studio.example.com',
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await server.close();
    rmSync(storage, { recursive: true, force: true });
  });

  const get = async (p: string) => {
    const addr = server.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return fetch(`http://127.0.0.1:${port}${p}`);
  };

  it('serves dist files of verified builds with a restrictive CSP', async () => {
    const res = await get(`/b/${goodBuild}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('preview');
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors https://studio.example.com');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const js = await get(`/b/${goodBuild}/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
  });

  it('404s failed builds, unknown builds, bad ids, and traversal', async () => {
    expect((await get(`/b/${badBuild}/index.html`)).status).toBe(404);
    expect((await get(`/b/build_nonexistent0000000000000000/index.html`)).status).toBe(404);
    expect((await get(`/b/not-a-build-id/index.html`)).status).toBe(404);
    expect((await get(`/b/${goodBuild}/../index.html`)).status).toBe(404);
    expect((await get(`/b/${goodBuild}/missing.html`)).status).toBe(404);
  });
});
