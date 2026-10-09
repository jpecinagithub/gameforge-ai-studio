import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  createRunSchema,
  newRunId,
  globalRedactor,
  TERMINAL_RUN_STATUSES,
  RunStatus,
  AgentEventKind,
  paginationSchema,
  page,
} from '@gameforge/shared';
import { conflict, notFound } from '../httpErrors.js';
import { apiError, ApiErrorCode } from '@gameforge/shared';
import { SSE_REPLAY_LIMIT } from '../security.js';
import { parseOr400, requireProject } from './routeUtil.js';
import { CreateRunBody, RunJson, ErrorEnvelope } from '../openapiSchemas.js';
import '../types.js';

interface RunRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  mode: string;
  status: string;
  current_step: string | null;
  budgets: Record<string, unknown>;
  journal: Record<string, unknown>;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

const RUN_COLS = `id, project_id, conversation_id, mode, status, current_step,
  budgets, journal, started_at, ended_at, created_at`;

function toRunJson(r: RunRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    mode: r.mode,
    status: r.status,
    currentStep: r.current_step,
    budgets: r.budgets ?? {},
    paused: Boolean((r.journal as Record<string, unknown> | null)?.paused),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
  };
}

async function requireRun(db: { query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }> }, id: string): Promise<RunRow> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM agent_runs WHERE id = $1`, [id]);
  if (rows.length === 0) throw notFound('run');
  return rows[0] as RunRow;
}

async function appendEvent(
  db: { query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }> },
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

const PAUSABLE = new Set<string>([
  RunStatus.QUEUED,
  RunStatus.PLANNING,
  RunStatus.RUNNING,
  RunStatus.WAITING_FOR_USER,
  RunStatus.BUILDING,
  RunStatus.TESTING,
  RunStatus.REVIEWING,
]);

export async function runRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, queues } = fastify.gameforge;

  fastify.get('/projects/:id/runs', async (req) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM agent_runs WHERE project_id = $1`,
        [projectId],
      ),
      db.query<RunRow>(
        `SELECT ${RUN_COLS} FROM agent_runs WHERE project_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [projectId, ps, offset],
      ),
    ]);
    return page(rows.map(toRunJson), Number(countRows[0]?.total ?? 0), p, ps);
  });

  fastify.post(
    '/projects/:id/runs',
    {
      schema: {
        tags: ['runs'],
        summary: 'Start an agent run (idempotent; 202 when enqueued)',
        body: CreateRunBody,
        response: { 200: RunJson, 202: RunJson, 400: ErrorEnvelope, 404: ErrorEnvelope },
      },
    },
    async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, projectId);
    const body = parseOr400(createRunSchema, req.body);
    const key = body.idempotencyKey ?? `run:${projectId}:${randomUUID()}`;

    // Idempotent: the same key always returns the same run, never a duplicate.
    const { rows: existing } = await db.query<RunRow>(
      `SELECT ${RUN_COLS} FROM agent_runs WHERE idempotency_key = $1`,
      [key],
    );
    if (existing.length > 0) return reply.code(200).send(toRunJson(existing[0] as RunRow));

    const runId = newRunId();
    const budgets = {
      maxIterations: 25,
      maxWallclockMs: 2 * 60 * 60 * 1000,
      maxTokens: 200000,
      maxCostUsd: 5,
      ...(body.budgets ?? {}),
    };
    const { rows } = await db.query<RunRow>(
      `INSERT INTO agent_runs
         (id, project_id, conversation_id, mode, status, plan, idempotency_key, budgets, journal)
       VALUES ($1,$2,$3,$4,'queued','{}',$5,$6,'{}')
       RETURNING ${RUN_COLS}`,
      [runId, projectId, body.conversationId ?? null, body.mode, key, JSON.stringify(budgets)],
    );
    await appendEvent(db, runId, AgentEventKind.RUN_CREATED, { mode: body.mode, budgets });

    try {
      // BullMQ jobId = idempotency key: the queue itself dedupes retries.
      await queues.addRunJob(runId, { projectId }, { jobId: key });
    } catch (err) {
      // Enqueue failed after insert: leave an honest trail, don't fake success.
      await db.query(
        `UPDATE agent_runs SET status = 'interrupted',
           error = $2 WHERE id = $1`,
        [runId, JSON.stringify({ code: 'enqueue_failed' })],
      );
      throw err;
    }
    return reply.code(202).send(toRunJson(rows[0] as RunRow));
    },
  );

  fastify.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return toRunJson(await requireRun(db, id));
  });

  fastify.post('/runs/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    const run = await requireRun(db, id);
    if (!PAUSABLE.has(run.status)) {
      throw conflict(`Cannot pause a run with status '${run.status}'`, { status: run.status });
    }
    const journal = { ...(run.journal ?? {}), paused: true };
    await db.query(`UPDATE agent_runs SET journal = $2 WHERE id = $1`, [id, JSON.stringify(journal)]);
    await appendEvent(db, id, AgentEventKind.PAUSED, {});
    return { id, paused: true };
  });

  fastify.post('/runs/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const run = await requireRun(db, id);
    if (!run.journal?.paused) throw conflict('Run is not paused', { status: run.status });
    const journal = { ...(run.journal ?? {}), paused: false };
    await db.query(`UPDATE agent_runs SET journal = $2 WHERE id = $1`, [id, JSON.stringify(journal)]);
    await appendEvent(db, id, AgentEventKind.RESUMED, {});
    return { id, paused: false };
  });

  fastify.post('/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const run = await requireRun(db, id);
    if (TERMINAL_RUN_STATUSES.has(run.status as never)) {
      throw conflict(`Run is already terminal ('${run.status}')`, { status: run.status });
    }
    await db.query(
      `UPDATE agent_runs SET status = 'canceled', ended_at = now() WHERE id = $1`,
      [id],
    );
    await appendEvent(db, id, AgentEventKind.STOPPED, { reason: 'user_canceled' });
    return { id, status: 'canceled' };
  });

  fastify.get('/runs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireRun(db, id);

    // Phase 7: bound concurrent streams before hijacking the socket.
    const slot = fastify.sseGuard.acquire(id);
    if (slot !== 'ok') {
      return reply
        .code(429)
        .header('retry-after', '5')
        .send(
          apiError(
            ApiErrorCode.RATE_LIMITED,
            slot === 'run_limit'
              ? 'Too many event streams for this run'
              : 'Too many concurrent event streams',
            String(req.id),
          ),
        );
    }

    // Replay support: Last-Event-ID: <runId>:<seq>
    let afterSeq = 0;
    const lastEventId = req.headers['last-event-id'];
    if (typeof lastEventId === 'string') {
      const m = /^(.+):(\d+)$/.exec(lastEventId);
      if (m && m[1] === id) afterSeq = Number.parseInt(m[2], 10);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    // Take over the raw response: Fastify must not attempt to send it.
    reply.hijack();

    let lastSeq = afterSeq;
    let closed = false;
    const release = () => {
      if (!closed) {
        closed = true;
        fastify.sseGuard.release(id);
      }
    };
    const onClose = () => {
      release();
      clearInterval(timer);
      clearInterval(heartbeat);
    };
    req.raw.on('close', onClose);

    const flush = async (): Promise<boolean> => {
      // Phase 7: replay is bounded — a client far behind catches up across
      // polls instead of receiving an unbounded burst in one response.
      const { rows } = await db.query<{
        seq: string;
        kind: string;
        payload: unknown;
        created_at: string;
      }>(
        `SELECT seq, kind, payload, created_at FROM agent_events
          WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT ${SSE_REPLAY_LIMIT()}`,
        [id, lastSeq],
      );
      for (const row of rows) {
        lastSeq = Number(row.seq);
        const data = JSON.stringify({
          seq: lastSeq,
          kind: row.kind,
          // Defense in depth: payloads are redacted on append; redact again on read.
          payload: globalRedactor.redactDeep(row.payload),
          createdAt: row.created_at,
        });
        reply.raw.write(`id: ${id}:${row.seq}\nevent: agent_event\ndata: ${data}\n\n`);
      }
      const { rows: statusRows } = await db.query<{ status: string }>(
        `SELECT status FROM agent_runs WHERE id = $1`,
        [id],
      );
      const status = statusRows[0]?.status;
      if (status && TERMINAL_RUN_STATUSES.has(status as never)) {
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
        reply.raw.end();
        return true;
      }
      return false;
    };

    const timer = setInterval(() => {
      if (!closed) void flush().then((done) => done && clearInterval(timer)).catch(() => {});
    }, 2000);

    // Heartbeat keeps proxies/NAT from silently killing idle streams.
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': ping\n\n');
    }, 15_000);

    try {
      const done = await flush();
      if (!done && !closed) {
        // Park the request until the client disconnects or the run terminates.
        await new Promise<void>((resolve) => req.raw.on('close', resolve));
      }
    } finally {
      clearInterval(timer);
      clearInterval(heartbeat);
      release();
      req.raw.off('close', onClose);
    }
    return reply;
  });
}
