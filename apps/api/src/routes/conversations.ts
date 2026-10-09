import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  newRunId,
  globalRedactor,
  AgentEventKind,
  postMessageSchema,
  paginationSchema,
  page,
} from '@gameforge/shared';
import { notFound } from '../httpErrors.js';
import { parseOr400, requireProject } from './routeUtil.js';
import '../types.js';

/** Conversations + messages (master prompt §23). */

type DbLike = {
  query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }>;
};

async function appendEvent(
  db: DbLike,
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const safe = globalRedactor.redactDeep(payload);
  await db.query(
    `INSERT INTO agent_events (run_id, task_id, seq, kind, payload)
     SELECT $1, NULL, COALESCE(MAX(seq), 0) + 1, $2, $3 FROM agent_events WHERE run_id = $1`,
    [runId, kind, JSON.stringify(safe)],
  );
}

interface QueuesLike {
  addRunJob(runId: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<unknown>;
}

/**
 * Create an agent run for a project (idempotent on the key) and enqueue it.
 * Mirrors POST /projects/:id/runs — kept local so the message flow owns its
 * idempotency key (`msg:<messageId>`).
 */
async function createRunForMessage(
  db: DbLike,
  queues: QueuesLike,
  projectId: string,
  conversationId: string,
  mode: string,
  idempotencyKey: string,
): Promise<{ id: string; status: string }> {
  const { rows: existing } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM agent_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing.length > 0) return existing[0] as { id: string; status: string };

  const runId = newRunId();
  const budgets = {
    maxIterations: 25,
    maxWallclockMs: 2 * 60 * 60 * 1000,
    maxTokens: 200000,
    maxCostUsd: 5,
  };
  await db.query(
    `INSERT INTO agent_runs
       (id, project_id, conversation_id, mode, status, plan, idempotency_key, budgets, journal)
     VALUES ($1,$2,$3,$4,'queued','{}',$5,$6,'{}')`,
    [runId, projectId, conversationId, mode, idempotencyKey, JSON.stringify(budgets)],
  );
  await appendEvent(db, runId, AgentEventKind.RUN_CREATED, { mode, budgets });
  await queues.addRunJob(runId, { projectId }, { jobId: idempotencyKey });
  return { id: runId, status: 'queued' };
}

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, queues } = fastify.gameforge;

  fastify.get('/projects/:id/messages', async (req) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    // One conversation per project for Phase 2 (created lazily on first message).
    const { rows: convRows } = await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
      [projectId],
    );
    if (convRows.length === 0) return page([], 0, p, ps);
    const conversationId = convRows[0].id;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM messages WHERE conversation_id = $1`, [
        conversationId,
      ]),
      db.query(
        `SELECT id, role, content, model, usage, created_at FROM messages
          WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
        [conversationId, ps, offset],
      ),
    ]);
    return page(
      rows.map((m) => {
        const r = m as Record<string, unknown>;
        return {
          id: r.id,
          role: r.role,
          content: r.content,
          model: r.model,
          usage: r.usage,
          createdAt: r.created_at,
        };
      }),
      Number(countRows[0]?.total ?? 0),
      p,
      ps,
    );
  });

  fastify.post('/projects/:id/messages', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const body = parseOr400(postMessageSchema, req.body);

    let conversationId: string;
    const { rows: convRows } = await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
      [projectId],
    );
    if (convRows.length > 0) {
      conversationId = convRows[0].id;
    } else {
      conversationId = randomUUID();
      await db.query(
        `INSERT INTO conversations (id, project_id, title) VALUES ($1, $2, $3)`,
        [conversationId, projectId, 'Studio chat'],
      );
    }
    const messageId = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO messages (id, conversation_id, role, content)
       VALUES ($1, $2, 'user', $3)
       RETURNING id, role, content, created_at`,
      [messageId, conversationId, body.content],
    );
    const m = rows[0] as Record<string, unknown>;

    // Phase 3: startRun wiring. A message can start a run (the chat composer
    // does this); the run id is returned so the UI can subscribe to its SSE.
    if (body.startRun) {
      const key = body.startRun.idempotencyKey ?? `msg:${messageId}`;
      const run = await createRunForMessage(
        db,
        queues,
        projectId,
        conversationId,
        body.startRun.mode,
        key,
      );
      return reply.code(201).send({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
        run,
      });
    }

    // If the project's latest run is waiting for the user, this message is the
    // answer: record it, re-queue the run, and let the director continue with
    // the answer in conversation context.
    const { rows: waitingRows } = await db.query<{ id: string; journal: Record<string, unknown> }>(
      `SELECT id, journal FROM agent_runs
       WHERE project_id = $1 AND status = 'waiting_for_user'
       ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (waitingRows.length > 0) {
      const waiting = waitingRows[0] as { id: string; journal: Record<string, unknown> };
      const questionId =
        (waiting.journal?.['waitingFor'] as { questionId?: string } | undefined)?.questionId ??
        null;
      const journal = { ...(waiting.journal ?? {}) };
      delete journal['waitingFor'];
      await db.query(`UPDATE agent_runs SET status = 'queued', journal = $2 WHERE id = $1`, [
        waiting.id,
        JSON.stringify(journal),
      ]);
      await appendEvent(db, waiting.id, AgentEventKind.QUESTION_ANSWERED, {
        questionId,
        messageId,
      });
      await queues.addRunJob(
        waiting.id,
        { projectId },
        { jobId: `resume:${waiting.id}:${messageId}` },
      );
      return reply.code(201).send({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
        resumedRun: waiting.id,
      });
    }

    return reply.code(201).send({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at });
  });

  fastify.get('/projects/:id/conversations/:cid', async () => {
    throw notFound('conversation detail view is planned for Phase 3');
  });
}
