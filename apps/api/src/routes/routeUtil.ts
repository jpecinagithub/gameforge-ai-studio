import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { globalRedactor } from '@gameforge/shared';
import { validationFailed, notFound } from '../httpErrors.js';
import type { DbClient } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string, what = 'id'): void {
  if (!UUID_RE.test(id)) throw notFound(what);
}

/** Validate with zod; on failure throw a 400 validation_failed envelope. */
export function parseOr400<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    const detail = globalRedactor.redactDeep({
      issues: res.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    }) as Record<string, unknown>;
    throw validationFailed(detail);
  }
  return res.data;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  template: string;
  kind: string | null;
  engine: string;
  status: string;
  current_revision_id: string | null;
  last_good_build_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Load a non-deleted project or throw 404. */
export async function requireProject(db: DbClient, id: string): Promise<ProjectRow> {
  assertUuid(id, 'project');
  const { rows } = await db.query<ProjectRow>(
    `SELECT id, slug, name, description, template, kind, engine, status,
            current_revision_id, last_good_build_id, metadata, created_at, updated_at
       FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) throw notFound('project');
  return rows[0] as ProjectRow;
}

export function requestIdOf(req: FastifyRequest): string {
  return String(req.id ?? 'unknown');
}

/** Serialize a project row for API responses (drops nothing sensitive — no secrets stored). */
export function toProjectJson(p: ProjectRow) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    template: p.template,
    kind: p.kind,
    engine: p.engine,
    status: p.status,
    currentRevisionId: p.current_revision_id,
    lastGoodBuildId: p.last_good_build_id,
    metadata: p.metadata ?? {},
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
