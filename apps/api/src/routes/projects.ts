import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  createProjectSchema,
  patchProjectSchema,
  paginationSchema,
  page,
} from '@gameforge/shared';
import { TEMPLATE_IDS } from './system.js';
import { badRequest, notFound, notImplemented } from '../httpErrors.js';
import { parseOr400, requireProject, toProjectJson, assertUuid } from './routeUtil.js';
import type { ProjectRow } from './routeUtil.js';
import {
  CreateProjectBody,
  ProjectJson,
  PatchProjectBody,
  ErrorEnvelope,
} from '../openapiSchemas.js';
import '../types.js';

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project';
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, git, storageRoot } = fastify.gameforge;
  const repoDir = (id: string) => join(storageRoot, 'projects', id, 'repo');

  fastify.get('/projects', async (req) => {
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM projects WHERE deleted_at IS NULL`,
      ),
      db.query<ProjectRow>(
        `SELECT id, slug, name, description, template, kind, engine, status,
                current_revision_id, last_good_build_id, metadata, created_at, updated_at
           FROM projects WHERE deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
        [ps, offset],
      ),
    ]);
    const total = Number(countRows[0]?.total ?? 0);
    return page(rows.map(toProjectJson), total, p, ps);
  });

  fastify.post(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Create a project (git repo is initialized for real)',
        body: CreateProjectBody,
        response: { 201: ProjectJson, 400: ErrorEnvelope },
      },
    },
    async (req, reply) => {
    const body = parseOr400(createProjectSchema, req.body);
    if (!TEMPLATE_IDS.includes(body.template as (typeof TEMPLATE_IDS)[number])) {
      throw badRequest(`Unknown template '${body.template}'`, { templates: [...TEMPLATE_IDS] });
    }
    const id = randomUUID();
    const slug = slugify(body.name);
    const dir = repoDir(id);
    // Git first: if the repo cannot be created we never insert the row (no orphans).
    try {
      await git.initRepo(dir, body.name);
    } catch (err) {
      await rm(join(storageRoot, 'projects', id), { recursive: true, force: true });
      throw err;
    }
    const { rows } = await db.query(
      `INSERT INTO projects (id, slug, name, description, template, kind, engine, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active','{}')
       RETURNING id, slug, name, description, template, kind, engine, status,
                 current_revision_id, last_good_build_id, metadata, created_at, updated_at`,
      [id, slug, body.name, body.description ?? null, body.template, body.kind ?? null, body.engine],
    );
    return reply.code(201).send(toProjectJson(rows[0] as never));
    },
  );

  fastify.get('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return toProjectJson(await requireProject(db, id));
  });

  fastify.patch(
    '/projects/:id',
    {
      schema: {
        tags: ['projects'],
        summary: 'Rename / update a project',
        body: PatchProjectBody,
        response: { 200: ProjectJson, 400: ErrorEnvelope, 404: ErrorEnvelope },
      },
    },
    async (req) => {
    const { id } = req.params as { id: string };
    await requireProject(db, id);
    const body = parseOr400(patchProjectSchema, req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      sets.push(`name = $${params.length + 1}`);
      params.push(body.name);
    }
    if (body.description !== undefined) {
      sets.push(`description = $${params.length + 1}`);
      params.push(body.description);
    }
    if (body.status !== undefined) {
      sets.push(`status = $${params.length + 1}`);
      params.push(body.status);
    }
    if (sets.length === 0) throw badRequest('Nothing to update');
    params.push(id);
    const { rows } = await db.query(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} AND deleted_at IS NULL
       RETURNING id, slug, name, description, template, kind, engine, status,
                 current_revision_id, last_good_build_id, metadata, created_at, updated_at`,
      params,
    );
    if (rows.length === 0) throw notFound('project');
    return toProjectJson(rows[0] as never);
    },
  );

  fastify.delete('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    await requireProject(db, id);
    // Soft delete: the row and the git repo are kept (Genex F6: removal hides, never destroys).
    await db.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [id]);
    return { id, deleted: true };
  });

  fastify.post('/projects/:id/duplicate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = await requireProject(db, id);
    const newId = randomUUID();
    const newName = `${src.name} (copy)`;
    try {
      await git.cloneRepo(repoDir(id), repoDir(newId));
    } catch (err) {
      await rm(join(storageRoot, 'projects', newId), { recursive: true, force: true });
      throw err;
    }
    const { rows } = await db.query(
      `INSERT INTO projects (id, slug, name, description, template, kind, engine, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)
       RETURNING id, slug, name, description, template, kind, engine, status,
                 current_revision_id, last_good_build_id, metadata, created_at, updated_at`,
      [
        newId,
        slugify(newName),
        newName,
        src.description,
        src.template,
        src.kind,
        src.engine,
        JSON.stringify({ ...(src.metadata ?? {}), duplicatedFrom: id }),
      ],
    );
    return reply.code(201).send(toProjectJson(rows[0] as never));
  });

  // Project export (ZIP of committed HEAD + README, with a secret scan).
  // A secret-shaped file REFUSES the export (honest 400) instead of leaking.
  fastify.get('/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'project');
    const project = await requireProject(db, id);
    const { buildExportZip, ExportBlockedError } = await import('../exportZip.js');
    try {
      const zip = await buildExportZip(repoDir(id), project.name, project.template ?? 'custom');
      reply.header('content-type', 'application/zip');
      reply.header(
        'content-disposition',
        `attachment; filename="${project.slug ?? 'game'}.zip"`,
      );
      return reply.send(zip);
    } catch (err) {
      if (err instanceof ExportBlockedError) {
        throw badRequest(
          `Export refused: secret-shaped content detected in ${err.offendingPaths.length} file(s)`,
          { files: err.offendingPaths.slice(0, 50) },
        );
      }
      throw err;
    }
  });

  fastify.post('/projects/import', async () => {
    throw notImplemented('Project import is planned for Phase 7');
  });
}
