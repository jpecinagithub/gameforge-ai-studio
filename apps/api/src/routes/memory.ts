import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema, page, globalRedactor } from '@gameforge/shared';
import { badRequest, conflict, notFound } from '../httpErrors.js';
import { parseOr400, requireProject } from './routeUtil.js';
import '../types.js';

/**
 * Memory routes — Phase 4: full read/write.
 *
 * Write semantics:
 * - POST creates a NEW current memory. If a current memory with the same
 *   (scope, project, key) exists → 409 (use PUT to revise). Strict create is
 *   the human/API contract; the agent `remember` tool uses upsert-supersede
 *   in the worker store instead.
 * - PUT /memories/:id revises: new row version+1, old row superseded_by → new
 *   id. 404 when missing, 409 when already superseded (history is immutable).
 * - DELETE /memories/:id is a TOMBSTONE: superseded_by is set to the row's
 *   OWN id (no replacement row). The `superseded_by IS NULL` "current"
 *   filter excludes it; a self-reference distinguishes tombstones from real
 *   supersedes. Nothing is ever hard-deleted (audit trail).
 * - All content is redacted before insert (ARCHITECTURE.md §5).
 */

const writeMemorySchema = z.object({
  key: z.string().min(1).max(120),
  content: z.string().min(1).max(8000),
  salience: z.number().min(0).max(1).optional(),
});

const reviseMemorySchema = z.object({
  content: z.string().min(1).max(8000),
  salience: z.number().min(0).max(1).optional(),
});

const MEMORY_COLS =
  'id, scope, project_id, run_id, key, content, salience, version, created_at, updated_at';

function toMemoryJson(m: Record<string, unknown>) {
  return {
    id: m.id,
    scope: m.scope,
    projectId: m.project_id ?? null,
    runId: m.run_id ?? null,
    key: m.key,
    content: m.content,
    salience: Number(m.salience),
    version: m.version,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  const { db } = fastify.gameforge;

  async function listMemories(scope: string, projectId: string | null, p: number, ps: number) {
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM memories
          WHERE scope = $1 AND ($2::uuid IS NULL OR project_id = $2) AND superseded_by IS NULL`,
        [scope, projectId],
      ),
      db.query(
        `SELECT ${MEMORY_COLS}
           FROM memories
          WHERE scope = $1 AND ($2::uuid IS NULL OR project_id = $2) AND superseded_by IS NULL
          ORDER BY salience DESC, updated_at DESC LIMIT $3 OFFSET $4`,
        [scope, projectId, ps, offset],
      ),
    ]);
    return page(
      rows.map((m) => toMemoryJson(m as Record<string, unknown>)),
      Number(countRows[0]?.total ?? 0),
      p,
      ps,
    );
  }

  async function getMemory(id: string) {
    const { rows } = await db.query(
      `SELECT ${MEMORY_COLS}, superseded_by FROM memories WHERE id = $1`,
      [id],
    );
    return (rows[0] as (Record<string, unknown> & { superseded_by: string | null }) | undefined) ?? null;
  }

  async function insertMemory(
    scope: 'project' | 'studio' | 'run',
    projectId: string | null,
    runId: string | null,
    body: z.infer<typeof writeMemorySchema>,
  ) {
    const content = globalRedactor.redactDeep(body.content);
    try {
      const { rows } = await db.query(
        `INSERT INTO memories (scope, project_id, run_id, key, content, salience)
         VALUES ($1, $2::uuid, $3, $4, $5, $6)
         RETURNING ${MEMORY_COLS}`,
        [scope, projectId, runId, body.key, content, body.salience ?? 0.5],
      );
      return toMemoryJson(rows[0] as Record<string, unknown>);
    } catch (err) {
      // Unique index memories_current_key → a current memory with this key exists.
      if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
        throw conflict(`A current memory with key "${body.key}" already exists; use PUT to revise it`, {
          key: body.key,
        });
      }
      throw err;
    }
  }

  fastify.get('/projects/:id/memories', async (req) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    return listMemories('project', projectId, p, ps);
  });

  fastify.get('/studio/memories', async (req) => {
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    return listMemories('studio', null, p, ps);
  });

  fastify.post('/projects/:id/memories', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const body = parseOr400(writeMemorySchema, req.body);
    const mem = await insertMemory('project', projectId, null, body);
    return reply.code(201).send(mem);
  });

  fastify.post('/studio/memories', async (req, reply) => {
    const body = parseOr400(writeMemorySchema, req.body);
    const mem = await insertMemory('studio', null, null, body);
    return reply.code(201).send(mem);
  });

  fastify.put('/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(reviseMemorySchema, req.body);
    const existing = await getMemory(id);
    if (!existing) throw notFound('memory');
    if (existing.superseded_by !== null)
      throw conflict('Memory has been superseded; history is immutable', { id });
    const content = globalRedactor.redactDeep(body.content);
    const { rows } = await db.query(
      `WITH ins AS (
         INSERT INTO memories (scope, project_id, run_id, key, content, salience, version)
         SELECT scope, project_id, run_id, key, $2, COALESCE($3, salience), version + 1
           FROM memories WHERE id = $1 AND superseded_by IS NULL
         RETURNING ${MEMORY_COLS}
       ),
       upd AS (
         UPDATE memories m SET superseded_by = ins.id, updated_at = now()
           FROM ins WHERE m.id = $1
       )
       SELECT * FROM ins`,
      [id, content, body.salience ?? null],
    );
    if (rows.length === 0) throw conflict('Memory was superseded concurrently', { id });
    return reply.code(200).send(toMemoryJson(rows[0] as Record<string, unknown>));
  });

  fastify.delete('/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getMemory(id);
    if (!existing) throw notFound('memory');
    if (existing.superseded_by !== null)
      throw conflict('Memory is already superseded', { id });
    // Tombstone: superseded_by points at the row itself — excluded from the
    // "current" filter, distinguishable from a real supersede, never deleted.
    await db.query(
      `UPDATE memories SET superseded_by = id, updated_at = now()
        WHERE id = $1 AND superseded_by IS NULL`,
      [id],
    );
    return reply.code(204).send();
  });
}
