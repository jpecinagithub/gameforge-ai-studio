/**
 * Game page server with in-memory HTML rewriting.
 *
 * Serves a built game directory over HTTP for headless verification. The ONLY
 * document ever rewritten is the served entry HTML — rewritten in memory on each
 * request, NEVER written to disk (idempotent: already-injected pages pass through
 * unchanged).
 *
 * The rewrite injects `<script src="/__studio/shim.js">` BEFORE any game module
 * script so the studio-owned shim (virtual clock, seeded RNG, error capture,
 * draw-call counting) is installed before game code runs.
 *
 * NOTE: strict Content-Security-Policy is the PREVIEW ORIGIN's job (reverse proxy),
 * not this server's. This server sets no-cache on HTML so evidence is always
 * linked to the exact bytes served.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PageServerOptions {
  /** 0 = ephemeral port (default). */
  port?: number;
  /** Entry document relative to gameDir. Default 'index.html'. */
  entry?: string;
}

export interface PageServer {
  url: string;
  close(): Promise<void>;
}

export const SHIM_ROUTE = '/__studio/shim.js';
const SHIM_MARKER = '__studio/shim.js';
const SHIM_TAG = `<script src="${SHIM_ROUTE}"></script>`;

/**
 * Inject the shim script tag before the first module script, else before
 * </head>, else at the top. Idempotent: if the marker is already present the
 * HTML is returned unchanged. Pure function — never touches disk.
 */
export function injectShim(html: string): string {
  if (html.includes(SHIM_MARKER)) return html;
  const moduleScript = /<script[^>]*type=["']module["'][^>]*>/i;
  if (moduleScript.test(html)) {
    return html.replace(moduleScript, (m) => `${SHIM_TAG}\n${m}`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${SHIM_TAG}\n</head>`);
  }
  return `${SHIM_TAG}\n${html}`;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
};

function resolveShimPath(): string {
  // Works both from dist/ (after build copies shim.js) and from src/ (vitest).
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'shim.js'), path.join(here, '..', 'src', 'shim.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('shim.js not found next to pageServer module');
}

/** Lexical containment: resolved path must stay inside root. */
function contained(root: string, rel: string): string | null {
  const resolved = path.resolve(root, '.' + path.sep + rel);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(withSep)) return null;
  return resolved;
}

export async function serveGame(
  gameDir: string,
  options: PageServerOptions = {},
): Promise<PageServer> {
  const root = path.resolve(gameDir);
  const entry = options.entry ?? 'index.html';
  const shimSource = fs.readFileSync(resolveShimPath(), 'utf8');

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      if (pathname === SHIM_ROUTE) {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(shimSource);
        return;
      }

      if (pathname === '/') pathname = '/' + entry;
      const rel = pathname.replace(/^\/+/, '');
      const file = contained(root, rel);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      const ext = path.extname(file).toLowerCase();
      const isEntry = path.basename(file) === path.basename(entry);
      let body: string | Buffer = fs.readFileSync(file);
      if (isEntry && ext === '.html') {
        // In-memory rewrite only. Disk is never touched.
        body = injectShim(body.toString('utf8'));
      }
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': isEntry ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(body);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
    }
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('page server failed to bind');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
