import Fastify, { type FastifyInstance } from 'fastify';
import { join, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

/**
 * Preview origin server (port 8091 in the Caddyfile).
 *
 * Serves ONLY the persisted `dist/` files of builds whose verdict is
 * verified or partial — the last-good lineage. Failed builds have no dist
 * artifacts (the pipeline persists none), so they can never be previewed.
 *
 * This origin hosts UNTRUSTED generated content: restrictive CSP, no framing
 * except by the studio UI, no sniffing. The studio embeds it in a sandboxed
 * iframe; these headers are defense-in-depth on top.
 */

const BUILD_ID_RE = /^build_[0-9A-HJKMNP-TV-Z]{26}$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface PreviewServerDeps {
  storageRoot: string;
  /** Minimal DB surface: status lookup for a build id. */
  db: {
    query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }>;
  };
  studioOrigin: string;
}

export function buildPreviewServer(deps: PreviewServerDeps): FastifyInstance {
  const { storageRoot, db, studioOrigin } = deps;
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  fastify.get('/b/:buildId/*', async (req, reply) => {
    const { buildId } = req.params as { buildId: string };
    if (!BUILD_ID_RE.test(buildId)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const rel = (req.params as { '*': string })['*'] || 'index.html';

    // Only verified/partial builds are servable.
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM build_jobs WHERE id = $1`,
      [buildId],
    );
    const status = rows[0]?.status;
    if (status !== 'verified' && status !== 'partial') {
      return reply.code(404).send({ error: 'not found' });
    }

    // Path containment: the artifacts dir is the jail.
    const distRoot = resolve(join(storageRoot, 'artifacts', buildId, 'dist'));
    const abs = resolve(join(distRoot, rel));
    if (abs !== distRoot && !abs.startsWith(distRoot + sep)) {
      return reply.code(404).send({ error: 'not found' });
    }
    let file = abs;
    try {
      const st = await stat(abs);
      if (st.isDirectory()) file = join(abs, 'index.html');
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }

    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }

    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    if (isHtml) {
      const prefix = `/b/${encodeURIComponent(buildId)}/`;
      const html = data.toString('utf8')
        .replace(/(src|href)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`);
      data = Buffer.from(html, 'utf8');
    }
    reply.header('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    // The Studio intentionally renders previews in an opaque sandbox
    // (`sandbox="allow-scripts"`, without `allow-same-origin`). Vite emits
    // module scripts and stylesheets with `crossorigin`, so the browser sends
    // those requests with Origin: null. The artifacts are public, immutable
    // game files; allowing them to be read cross-origin lets those resources
    // load without weakening the iframe sandbox.
    reply.header('access-control-allow-origin', '*');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    // Templates load three.js from the pinned jsdelivr CDN; everything else is
    // same-origin. No framing except by the studio UI.
    reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
        `img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; ` +
        `connect-src 'self'; worker-src 'self' blob:; frame-ancestors ${studioOrigin}`,
    );
    // HTML is never cached (the studio reloads on new builds); hashed assets
    // can be cached.
    reply.header('cache-control', isHtml ? 'no-store' : 'public, max-age=31536000, immutable');
    return reply.send(data);
  });

  // Project preview (for static games without a build): serves the repo directly.
  fastify.get('/p/:projectId/*', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const rel = (req.params as { '*': string })['*'] || 'index.html';

    const repoRoot = resolve(join(storageRoot, 'projects', projectId, 'repo'));
    // Source previews are only valid for dependency-free static projects.
    // Projects with package.json must be served from their persisted build.
    try {
      await stat(join(repoRoot, 'package.json'));
      return reply.code(404).send({ error: 'build required' });
    } catch {
      // No package.json: continue with the static source preview.
    }
    const abs = resolve(join(repoRoot, rel));
    if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) {
      return reply.code(404).send({ error: 'not found' });
    }
    let file = abs;
    try {
      const st = await stat(abs);
      if (st.isDirectory()) file = join(abs, 'index.html');
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }

    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }

    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    if (isHtml) {
      const prefix = `/p/${encodeURIComponent(projectId)}/`;
      const html = data.toString('utf8')
        .replace(/(src|href)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`);
      data = Buffer.from(html, 'utf8');
    }
    reply.header('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    // Source previews use the same opaque iframe sandbox as persisted builds.
    // Their scripts and styles therefore need an explicit CORS response too.
    reply.header('access-control-allow-origin', '*');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
        `style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; ` +
        `font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors ${studioOrigin}`,
    );
    reply.header('cache-control', 'no-store');
    return reply.send(data);
  });

  fastify.get('/health', async () => ({ ok: true, service: 'preview' }));

  return fastify;
}
