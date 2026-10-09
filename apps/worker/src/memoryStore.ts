/**
 * PostgreSQL MemoryStore implementation (worker wiring).
 *
 * Write semantics here are UPSERT-supersede (not the API's strict-create):
 * writing an existing current (scope, project, key) supersedes the old row
 * with a version+1 row. This keeps the agent `remember` tool self-healing —
 * an agent re-stating a key never 409s mid-run. The human API contract
 * (POST = strict create, 409 on duplicate) is intentionally stricter; see
 * apps/api/src/routes/memory.ts.
 *
 * Tombstones (superseded_by = own id) are never resurrected and never
 * returned by listCurrent/search.
 */
import type {
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  MemoryWriteInput,
} from '@gameforge/agent-core';
import type { DbPool } from './db.js';

const COLS =
  'id, scope, project_id, run_id, key, content, salience, version, created_at, updated_at';

function toRecord(r: Record<string, unknown>): MemoryRecord {
  return {
    id: String(r.id),
    scope: r.scope as MemoryScope,
    projectId: (r.project_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    key: String(r.key),
    content: String(r.content),
    salience: Number(r.salience),
    version: Number(r.version),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export function createPgMemoryStore(pool: DbPool): MemoryStore {
  return {
    async write(input: MemoryWriteInput): Promise<MemoryRecord> {
      const { rows } = await pool.query(
        `WITH ins AS (
           INSERT INTO memories (scope, project_id, run_id, key, content, salience, version)
           SELECT $1, $2::uuid, $3, $4, $5, COALESCE($6, 0.5),
                  COALESCE((SELECT version + 1 FROM memories
                     WHERE scope = $1
                       AND COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
                         = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
                       AND key = $4 AND superseded_by IS NULL), 1)
           RETURNING ${COLS}
         ),
         upd AS (
           UPDATE memories m SET superseded_by = ins.id, updated_at = now()
             FROM ins
            WHERE m.scope = ins.scope
              AND COALESCE(m.project_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE(ins.project_id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND m.key = ins.key AND m.superseded_by IS NULL AND m.id <> ins.id
         )
         SELECT * FROM ins`,
        [
          input.scope,
          input.projectId ?? null,
          input.runId ?? null,
          input.key,
          input.content,
          input.salience ?? null,
        ],
      );
      if (rows.length === 0) throw new Error('memory write produced no row');
      return toRecord(rows[0] as Record<string, unknown>);
    },

    async supersede(id: string, content: string, salience?: number): Promise<MemoryRecord> {
      const { rows } = await pool.query(
        `WITH ins AS (
           INSERT INTO memories (scope, project_id, run_id, key, content, salience, version)
           SELECT scope, project_id, run_id, key, $2, COALESCE($3, salience), version + 1
             FROM memories WHERE id = $1 AND superseded_by IS NULL
           RETURNING ${COLS}
         ),
         upd AS (
           UPDATE memories m SET superseded_by = ins.id, updated_at = now()
             FROM ins WHERE m.id = $1
         )
         SELECT * FROM ins`,
        [id, content, salience ?? null],
      );
      if (rows.length === 0)
        throw new Error(`cannot supersede memory ${id}: missing or already superseded`);
      return toRecord(rows[0] as Record<string, unknown>);
    },

    async listCurrent(scope: MemoryScope, projectId?: string | null): Promise<MemoryRecord[]> {
      const { rows } = await pool.query(
        `SELECT ${COLS} FROM memories
          WHERE scope = $1
            AND ($2::uuid IS NULL OR project_id = $2::uuid)
            AND superseded_by IS NULL
          ORDER BY salience DESC, updated_at DESC`,
        [scope, projectId ?? null],
      );
      return rows.map((r) => toRecord(r as Record<string, unknown>));
    },

    async search(
      scope: MemoryScope,
      projectId: string | null | undefined,
      query: string,
      limit: number,
    ): Promise<MemoryRecord[]> {
      // SQL-level keyword prefilter (ILIKE on content/key); the pure
      // relevance ranking in agent-core refines ordering.
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3)
        .slice(0, 8);
      const likes = terms.map((_, i) => `(content ILIKE $${i + 3} OR key ILIKE $${i + 3})`);
      const where =
        likes.length > 0 ? `AND (${likes.join(' OR ')})` : '';
      const { rows } = await pool.query(
        `SELECT ${COLS} FROM memories
          WHERE scope = $1
            AND ($2::uuid IS NULL OR project_id = $2::uuid)
            AND superseded_by IS NULL
            ${where}
          ORDER BY salience DESC, updated_at DESC
          LIMIT $${terms.length + 3}`,
        [scope, projectId ?? null, ...terms.map((t) => `%${t}%`), Math.max(1, limit)],
      );
      return rows.map((r) => toRecord(r as Record<string, unknown>));
    },
  };
}
