import type { FastifyInstance } from 'fastify';
import { join, resolve, sep } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createBuildSchema, newBuildId, paginationSchema, page } from '@gameforge/shared';
import { notFound } from '../httpErrors.js';
import { parseOr400, requireProject, assertUuid } from './routeUtil.js';
import '../types.js';

/**
 * Build routes — Phase 2 skeleton. Creating a build records the build_jobs row
 * and enqueues the pipeline job; the 15-phase pipeline itself lands in Phase 3.
 */

interface BuildRow {
  id: string;
  project_id: string;
  run_id: string | null;
  revision_sha: string;
  status: string;
  verdict: Record<string, unknown> | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

const BUILD_COLS = `id, project_id, run_id, revision_sha, status, verdict, started_at, ended_at, created_at`;

function previewUrlFor(status: string, buildId: string): string | null {
  if (status !== 'verified' && status !== 'partial') return null;
  const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:8091';
  return `${origin}/b/${buildId}/`;
}

function toBuildJson(b: BuildRow) {
  return {
    id: b.id,
    projectId: b.project_id,
    runId: b.run_id,
    revisionSha: b.revision_sha,
    status: b.status,
    verdict: b.verdict,
    // The studio UI reads `preview_url` (snake_case) for the iframe source.
    preview_url: previewUrlFor(b.status, b.id),
    startedAt: b.started_at,
    endedAt: b.ended_at,
    createdAt: b.created_at,
  };
}

export async function buildRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, queues } = fastify.gameforge;

  fastify.post('/projects/:id/builds', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const project = await requireProject(db, projectId);
    const body = parseOr400(createBuildSchema, req.body);
    const revisionSha = project.current_revision_id;
    if (!revisionSha) {
      // No committed revision yet — nothing to build. Honest 400, not a fake build.
      const { badRequest } = await import('../httpErrors.js');
      throw badRequest('Project has no committed revision yet');
    }
    const buildId = newBuildId();
    const jobId = body.idempotencyKey ?? buildId;
    const { rows } = await db.query<BuildRow>(
      `INSERT INTO build_jobs (id, project_id, revision_sha, status, build_dir)
       VALUES ($1,$2,$3,'queued',$4) RETURNING ${BUILD_COLS}`,
      [buildId, projectId, revisionSha, `scratch/${projectId}-${buildId}`],
    );
    await queues.addBuildJob(buildId, { projectId, revisionSha }, { jobId });
    return reply.code(202).send(toBuildJson(rows[0] as BuildRow));
  });

  fastify.get('/projects/:id/builds', async (req) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM build_jobs WHERE project_id = $1`, [
        projectId,
      ]),
      db.query<BuildRow>(
        `SELECT ${BUILD_COLS} FROM build_jobs WHERE project_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [projectId, ps, offset],
      ),
    ]);
    return page(rows.map(toBuildJson), Number(countRows[0]?.total ?? 0), p, ps);
  });

  fastify.get('/builds/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query<BuildRow>(`SELECT ${BUILD_COLS} FROM build_jobs WHERE id = $1`, [id]);
    if (rows.length === 0) throw notFound('build');
    return toBuildJson(rows[0] as BuildRow);
  });

  async function requireBuild(id: string): Promise<BuildRow> {
    const { rows } = await db.query<BuildRow>(`SELECT ${BUILD_COLS} FROM build_jobs WHERE id = $1`, [id]);
    if (rows.length === 0) throw notFound('build');
    return rows[0] as BuildRow;
  }

  fastify.get('/builds/:id/tests', async (req) => {
    const { id } = req.params as { id: string };
    await requireBuild(id);
    const { rows } = await db.query(
      `SELECT suite, name, status, duration_ms, details, created_at
         FROM test_results WHERE build_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return rows.map((t) => {
      const r = t as Record<string, unknown>;
      return {
        suite: r.suite,
        name: r.name,
        status: r.status,
        durationMs: r.duration_ms,
        details: r.details,
        createdAt: r.created_at,
      };
    });
  });

  fastify.get('/builds/:id/reviews', async (req) => {
    const { id } = req.params as { id: string };
    await requireBuild(id);
    const { rows } = await db.query(
      `SELECT criterion, result, confidence, evidence, issue, recommendation,
              retest_required, judge_model, created_at
         FROM review_results WHERE build_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return rows.map((t) => {
      const r = t as Record<string, unknown>;
      return {
        criterion: r.criterion,
        result: r.result,
        confidence: r.confidence,
        evidence: r.evidence,
        issue: r.issue,
        recommendation: r.recommendation,
        retestRequired: r.retest_required,
        judgeModel: r.judge_model,
        createdAt: r.created_at,
      };
    });
  });

  fastify.get('/builds/:id/artifacts', async (req) => {
    const { id } = req.params as { id: string };
    await requireBuild(id);
    const { rows } = await db.query(
      `SELECT id, kind, path, size_bytes, content_hash, metadata, created_at
         FROM build_artifacts WHERE build_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return rows.map((t) => {
      const r = t as Record<string, unknown>;
      const name = String(r.path).split('/').pop() ?? String(r.path);
      return {
        id: r.id,
        kind: r.kind,
        name,
        size: r.size_bytes,
        url: `/api/v1/artifacts/${r.id}/download`,
        createdAt: r.created_at,
      };
    });
  });

  fastify.get('/artifacts/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'artifact');
    const { rows } = await db.query(
      `SELECT id, build_id, path FROM build_artifacts WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) throw notFound('artifact');
    const row = rows[0] as Record<string, unknown>;
    // Containment: the artifacts dir is the jail.
    const root = resolve(join(fastify.gameforge.storageRoot, 'artifacts'));
    const abs = resolve(join(root, String(row.build_id), String(row.path)));
    if (abs !== root && !abs.startsWith(root + sep)) throw notFound('artifact');
    let data;
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw notFound('artifact');
      data = await readFile(abs);
    } catch {
      throw notFound('artifact');
    }
    const name = String(row.path).split('/').pop() ?? 'artifact';
    reply.header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(data);
  });
}
