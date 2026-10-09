import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { globalRedactor } from '@gameforge/shared';

const execFileAsync = promisify(execFile);

/**
 * Project source export (master prompt §11 "export").
 *
 * Exports the committed HEAD of the project repo as a ZIP (stored entries,
 * no compression — dependency-free), plus a generated README with build/run
 * instructions. Before zipping, every file is scanned for secrets; if any
 * file trips the redactor, the export is REFUSED with the offending paths
 * (never their contents). A refused export is an honest 400, not a leak.
 */

export class ExportBlockedError extends Error {
  readonly offendingPaths: string[];
  constructor(offendingPaths: string[]) {
    super(`export blocked: ${offendingPaths.length} file(s) contain secret-shaped content`);
    this.name = 'ExportBlockedError';
    this.offendingPaths = offendingPaths;
  }
}

/* CRC-32 (IEEE) for the ZIP headers. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function gitListFiles(repoDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoDir, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split('\0').filter((s) => s.length > 0).slice(0, MAX_FILES);
}

async function gitShow(repoDir: string, path: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, 'show', `HEAD:${path}`], {
    timeout: 30000,
    maxBuffer: Math.max(MAX_FILE_BYTES + 1024, 16 * 1024 * 1024),
    encoding: 'buffer',
  });
  return stdout as Buffer;
}

/** Minimal stored-entry ZIP writer. Deterministic timestamps. */
function writeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  // DOS date/time for 2026-10-09 00:00:00.
  const dosTime = (0 << 11) | (0 << 5) | 0;
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 9;

  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

function exportReadme(projectName: string, template: string): string {
  return `# ${projectName}

Exported from GameForge AI Studio. Built on the \`${template}\` starter template.

## Run it

No build step is required. Serve this folder with any static file server:

\`\`\`bash
npx serve .
# or
python3 -m http.server 8080
\`\`\`

Then open http://localhost:8080 (or :8000) in a browser and open \`index.html\`.

The game loads three.js from the pinned jsDelivr CDN (see the import map in
\`index.html\`); an internet connection is needed for the 3D templates.

## The window.__studio contract

Every template exposes \`window.__studio\` for deterministic testing:

- \`__studio.seed(n)\` — seed the RNG
- \`__studio.ready()\` — readiness flag (a fact the page reports, never a wait)
- \`__studio.step(dtMs)\` — advance the simulation deterministically
- \`__studio.state()\` — JSON-serializable game state
- \`__studio.inspect(query)\` — scene/entity inspection
- \`__studio.demos()\` / \`__studio.demo(name)\` — canned scenarios

Keep this contract intact if you modify the game: it is what the studio's
build pipeline, visual evidence gathering, and acceptance checks run against.

## License note

Starter template code is original to GameForge AI Studio (MIT). Your own
changes are yours. Third-party CDN libraries keep their own licenses.
`;
}

export async function buildExportZip(
  repoDir: string,
  projectName: string,
  template: string,
): Promise<Buffer> {
  const paths = await gitListFiles(repoDir);
  const entries: Array<{ name: string; data: Buffer }> = [];
  const offending: string[] = [];

  for (const p of paths) {
    if (p.includes('..') || p.startsWith('/')) continue;
    const data = await gitShow(repoDir, p);
    if (data.length > MAX_FILE_BYTES) continue;
    // Secret scan: the redactor knows registered secrets + credential shapes.
    // A change means the file trips it — refuse the export, name the file.
    try {
      const text = data.toString('utf8');
      if (globalRedactor.redactDeep(text) !== text) offending.push(p);
    } catch {
      // Binary file — scan the raw bytes as latin1 for credential shapes.
      const text = data.toString('latin1');
      if (globalRedactor.redactDeep(text) !== text) offending.push(p);
    }
    entries.push({ name: p, data });
  }

  if (offending.length > 0) throw new ExportBlockedError(offending);

  entries.push({
    name: 'GAMEFORGE_README.md',
    data: Buffer.from(exportReadme(projectName, template), 'utf8'),
  });
  return writeZip(entries);
}
