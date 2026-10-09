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
    reply.header('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
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

  fastify.get('/health', async () => ({ ok: true, service: 'preview' }));

  return fastify;
}
