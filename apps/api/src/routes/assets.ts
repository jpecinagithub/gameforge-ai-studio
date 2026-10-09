import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep, extname, basename } from 'node:path';
import { mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { paginationSchema, page, globalRedactor } from '@gameforge/shared';
import { badRequest, notFound, notImplemented, payloadTooLarge } from '../httpErrors.js';
import { parseOr400, requireProject, assertUuid } from './routeUtil.js';
import '../types.js';

/**
 * Asset routes — Phase 5: real upload/delete on top of the DB inventory.
 * AI generation stays an honest 501 (Phase 6).
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB
const ASSET_KINDS = [
  'model',
  'material',
  'texture',
  'image',
  'sprite',
  'animation',
  'audio',
  'music',
  'video',
  'font',
  'other',
] as const;

const uploadQuerySchema = z.object({
  kind: z.enum(ASSET_KINDS).optional(),
});

const EXT_TO_KIND: Record<string, (typeof ASSET_KINDS)[number]> = {
  '.glb': 'model',
  '.gltf': 'model',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.mp4': 'video',
  '.webm': 'video',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
};

/** Strip directories and unsafe chars from an uploaded filename. */
function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/\\/g, '');
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || 'file';
}

function toAssetJson(r: Record<string, unknown>, projectId: string) {
  return {
    id: r.id,
    projectId,
    path: r.path,
    kind: r.kind,
    format: r.format,
    bytes: r.bytes,
    contentHash: r.content_hash,
    source: r.source,
    useStage: r.use_stage,
    url: `/api/v1/assets/${r.id}/download`,
    createdAt: r.created_at,
  };
}

export async function assetRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, storageRoot } = fastify.gameforge;
  const assetFile = (projectId: string, storedName: string) =>
    join(storageRoot, 'assets', projectId, storedName);

  fastify.get('/projects/:id/assets', async (req) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM assets WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      ),
      db.query(
        `SELECT id, project_id, path, kind, format, bytes, content_hash, source, use_stage, created_at
           FROM assets WHERE project_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [projectId, ps, offset],
      ),
    ]);
    return page(
      rows.map((a) => toAssetJson(a as Record<string, unknown>, projectId)),
      Number(countRows[0]?.total ?? 0),
      p,
      ps,
    );
  });

  fastify.post('/projects/:id/assets', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    assertUuid(projectId, 'project');
    await requireProject(db, projectId);
    const query = parseOr400(uploadQuerySchema, req.query);

    const part = await req.file();
    if (!part) throw badRequest('A file part named "file" is required');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        throw payloadTooLarge(`Asset is larger than ${MAX_UPLOAD_BYTES} bytes`, {
          filename: part.filename,
        });
      }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (data.length === 0) throw badRequest('Uploaded file is empty');

    const safeName = sanitizeFilename(part.filename || 'file');
    const ext = extname(safeName).toLowerCase().slice(1);
    const kind = query.kind ?? EXT_TO_KIND[`.${ext}`] ?? 'other';
    const assetId = randomUUID();
    const storedName = `${assetId}_${safeName}`;
    const relPath = `${projectId}/${storedName}`;

    await mkdir(join(storageRoot, 'assets', projectId), { recursive: true });
    await writeFile(assetFile(projectId, storedName), data);
    const contentHash = createHash('sha256').update(data).digest('hex');

    const redactedName = globalRedactor.redactText(safeName);
    const { rows } = await db.query(
      `INSERT INTO assets (id, project_id, path, kind, format, bytes, content_hash, source, use_stage, properties)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'upload','unconfirmed','{}')
       RETURNING id, project_id, path, kind, format, bytes, content_hash, source, use_stage, created_at`,
      [assetId, projectId, relPath, kind, ext || 'bin', data.length, contentHash],
    );
    // Store the redacted display name in properties (never raw secrets).
    await db.query(`UPDATE assets SET properties = $2 WHERE id = $1`, [
      assetId,
      JSON.stringify({ originalName: redactedName }),
    ]);
    return reply.code(201).send(toAssetJson(rows[0] as Record<string, unknown>, projectId));
  });

  fastify.get('/assets/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'asset');
    const { rows } = await db.query(
      `SELECT id, project_id, path FROM assets WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) throw notFound('asset');
    const row = rows[0] as Record<string, unknown>;
    const projectId = String(row.project_id);
    const storedName = String(row.path).split('/').pop() ?? '';
    // Containment: the assets dir is the jail.
    const root = resolve(join(storageRoot, 'assets', projectId));
    const abs = resolve(join(root, storedName));
    if (abs !== root && !abs.startsWith(root + sep)) throw notFound('asset');
    let data;
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw notFound('asset');
      data = await readFile(abs);
    } catch {
      throw notFound('asset');
    }
    reply.header('content-disposition', `attachment; filename="${sanitizeFilename(storedName)}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(data);
  });

  fastify.delete('/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'asset');
    const { rows } = await db.query(
      `SELECT id, project_id, path FROM assets WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) throw notFound('asset');
    const row = rows[0] as Record<string, unknown>;
    const projectId = String(row.project_id);
    const storedName = String(row.path).split('/').pop() ?? '';
    const root = resolve(join(storageRoot, 'assets', projectId));
    const abs = resolve(join(root, storedName));
    if (abs === root || !abs.startsWith(root + sep)) throw notFound('asset');
    await rm(abs, { force: true });
    await db.query(`UPDATE assets SET deleted_at = now() WHERE id = $1`, [id]);
    return reply.code(204).send();
  });

  fastify.post('/assets/generations', async () => {
    throw notImplemented('Asset generation is planned for Phase 6');
  });

  fastify.get('/assets/generations/:id', async () => {
    throw notImplemented('Asset generation status is planned for Phase 6');
  });
}
