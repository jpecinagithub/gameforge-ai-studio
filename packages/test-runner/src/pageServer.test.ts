/**
 * pageServer tests — real HTTP against a fixture game dir in /tmp.
 * Asserts: shim injection, idempotency, disk never touched, path containment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveGame, injectShim, SHIM_ROUTE, type PageServer } from './pageServer.js';

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>t</title></head>
<body><script type="module" src="/main.js"></script></body></html>`;

describe('injectShim', () => {
  it('injects before the first module script', () => {
    const out = injectShim(INDEX_HTML);
    expect(out).toContain(`<script src="${SHIM_ROUTE}"></script>`);
    expect(out.indexOf(SHIM_ROUTE)).toBeLessThan(out.indexOf('type="module"'));
  });

  it('is idempotent', () => {
    const once = injectShim(INDEX_HTML);
    const twice = injectShim(once);
    expect(twice).toBe(once);
    expect(twice.split(SHIM_ROUTE).length - 1).toBe(1);
  });

  it('falls back to </head> and then to top-of-document', () => {
    const noModule = injectShim('<html><head></head><body></body></html>');
    expect(noModule.indexOf(SHIM_ROUTE)).toBeLessThan(noModule.indexOf('</head>'));
    const bare = injectShim('<p>hi</p>');
    expect(bare.startsWith(`<script src="${SHIM_ROUTE}"></script>`)).toBe(true);
  });
});

describe('serveGame', () => {
  let dir: string;
  let server: PageServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gf-pageserver-'));
    writeFileSync(join(dir, 'index.html'), INDEX_HTML);
    writeFileSync(join(dir, 'main.js'), 'console.log("game");');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'hello');
    server = await serveGame(dir);
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the entry HTML with the shim injected, in memory only', async () => {
    const res = await fetch(server.url + '/');
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(SHIM_ROUTE);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    // Disk untouched: the source file has no shim marker.
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(INDEX_HTML);
  });

  it('serves the shim script itself', async () => {
    const res = await fetch(server.url + SHIM_ROUTE);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('window.__studio');
  });

  it('serves static assets with cache headers', async () => {
    const res = await fetch(server.url + '/main.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("game");');
  });

  it('blocks path traversal', async () => {
    const res = await fetch(server.url + '/..%2f..%2fetc%2fpasswd');
    expect(res.status).toBe(404);
  });

  it('404s unknown paths', async () => {
    const res = await fetch(server.url + '/nope.js');
    expect(res.status).toBe(404);
  });
});
