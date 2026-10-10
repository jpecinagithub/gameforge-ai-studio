import path from 'node:path';
import {
  AgentEventKind,
  BuildStatus,
  RunStatus,
  TERMINAL_RUN_STATUSES,
  newBuildId,
  type SecretRedactor,
} from '@gameforge/shared';
import {
  isPauseForUser,
  runMultiAgentJob,
  toStopCode,
  relevanceRetrieve,
  formatMemoriesForPrompt,
  type EvidenceProvider,
  type EventsOps,
} from '@gameforge/agent-core';
import { createPgTaskStore } from './taskStore.js';
import {
  BudgetExhaustedError,
  type CloudflareClient,
  type ModelRegistry,
} from '@gameforge/model-providers';
import type { DbPool } from './db.js';
import { appendEvent } from './events.js';
import { createPgMemoryStore } from './memoryStore.js';

/**
 * Durable agent-run processor.
 *
 * Skeleton (crash-safe plumbing) owned here:
 *  - Loads the agent_runs row; terminal runs are an idempotent no-op.
 *  - Claims queued runs atomically (UPDATE … WHERE status='queued') so exactly
 *    one worker wins. Resume-after-answer re-queues as 'queued' via the API.
 *  - Rehydrates the run journal; steps already marked done are never repeated
 *    (crash-retry resumes, never replays).
 *  - Honors pause (re-delay the job) and cancel before every phase.
 *  - On unexpected throw: marks the run `interrupted` (NOT failed) with a typed
 *    error event, so a human can resume. Never silently repeats completed work.
 *
 * The actual agent work (director turn, tools, builds, evidence) is delegated
 * to runAgentJob() from @gameforge/agent-core (Phase 3).
 */

export interface RunRow {
  id: string;
  project_id: string;
  status: string;
  mode: string;
  journal: Record<string, unknown> | null;
  plan: unknown;
}

/** Queue adapter surface the director needs (BullMQ-backed in index.ts). */
export interface DirectorQueues {
  enqueueBuild(
    projectId: string,
    runId: string,
    revisionSha: string,
  ): Promise<{ buildId: string }>;
  getBuildStatus(
    buildId: string,
  ): Promise<{ status: BuildStatus; verdict?: unknown }>;
}

export interface ProcessorDeps {
  pool: DbPool;
  redactor: Pick<SecretRedactor, 'redactDeep'>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  storageRoot: string;
  /** Null when CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID are not configured — runs fail closed with a typed error. */
  provider: CloudflareClient | null;
  registry: ModelRegistry;
  queues: DirectorQueues;
  evidence: EvidenceProvider;
}

/** Minimal surface of a BullMQ Job needed here (mockable in tests). */
export interface JobLike {
  data: { runId: string };
  /** Re-schedule this active job for later (used on pause). */
  moveToDelayed(timestamp: number): Promise<void>;
}

export type RunOutcome =
  | 'noop'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'canceled'
  | 'waiting'
  | 'interrupted';

const PAUSE_DELAY_MS = 60_000;

function stepsDoneOf(journal: Record<string, unknown> | null | undefined): string[] {
  const s = journal?.['stepsDone'];
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : [];
}

export async function processAgentRun(
  job: JobLike,
  deps: ProcessorDeps,
): Promise<{ outcome: RunOutcome }> {
  const { pool, redactor, log, storageRoot, provider, registry, queues, evidence } = deps;
  const runId = job.data.runId;
  const logF = (msg: string, fields?: Record<string, unknown>) =>
    log(msg, { runId, ...fields });

  const loadRun = async (): Promise<RunRow | null> => {
    const { rows } = await pool.query(
      'SELECT id, project_id, status, mode, journal, plan FROM agent_runs WHERE id = $1',
      [runId],
    );
    return (rows[0] as RunRow | undefined) ?? null;
  };

  /** Re-read control state; handle pause/cancel. Returns true if the caller must stop. */
  const checkControl = async (): Promise<RunOutcome | null> => {
    const row = await loadRun();
    if (!row) throw new Error(`agent_runs row missing for ${runId}`);
    if (row.status === RunStatus.CANCELED) {
      await appendEvent(pool, redactor, runId, AgentEventKind.STOPPED, {
        reason: 'canceled by user',
      });
      await pool.query(
        "UPDATE agent_runs SET ended_at = COALESCE(ended_at, now()) WHERE id = $1",
        [runId],
      );
      logF('run canceled');
      return 'canceled';
    }
    const journal = (row.journal ?? {}) as Record<string, unknown>;
    if (journal['paused'] === true) {
      await appendEvent(pool, redactor, runId, AgentEventKind.PAUSED, {
        reason: 'paused by user; job re-delayed',
      });
      await job.moveToDelayed(Date.now() + PAUSE_DELAY_MS);
      logF('run paused; job delayed');
      return 'paused';
    }
    return null;
  };

  const markFailed = async (code: string, detail: string): Promise<{ outcome: RunOutcome }> => {
    await pool.query(
      "UPDATE agent_runs SET status = 'failed', ended_at = now(), error = $2 WHERE id = $1",
      [runId, JSON.stringify({ code, detail })],
    );
    await appendEvent(pool, redactor, runId, AgentEventKind.ERROR, { code, detail });
    logF('run failed', { code });
    return { outcome: 'failed' };
  };

  try {
    const row = await loadRun();
    if (!row) throw new Error(`agent_runs row missing for ${runId}`);

    // 1. Idempotent no-op on terminal runs.
    if (TERMINAL_RUN_STATUSES.has(row.status as RunStatus)) {
      logF('terminal run; no-op', { status: row.status });
      return { outcome: 'noop' };
    }

    // 2. Control check before claiming.
    const pre = await checkControl();
    if (pre) return { outcome: pre };

    // 3. Atomic claim: only one worker transitions queued -> planning.
    const claimed = await pool.query(
      `UPDATE agent_runs
         SET status = 'planning', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'queued'`,
      [runId],
    );
    if (claimed.rowCount === 0) {
      logF('claim lost or status changed; no-op');
      return { outcome: 'noop' };
    }
    await appendEvent(pool, redactor, runId, AgentEventKind.STATUS_CHANGED, {
      from: RunStatus.QUEUED,
      to: RunStatus.PLANNING,
    });

    // 4. Rehydrate journal — resume, never replay.
    const afterClaim = await loadRun();
    const journal = ((afterClaim?.journal ?? {}) as Record<string, unknown>) ?? {};
    const done = stepsDoneOf(journal);
    const projectId = afterClaim?.project_id;
    if (!projectId) throw new Error(`agent_runs ${runId} has no project_id`);

    // 5. Fail closed without an LLM key — never fake a run.
    if (!provider) {
      return await markFailed(
        'model_unavailable',
        'CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID are not configured on the server; the director cannot run.',
      );
    }

    // 6. Control check before the expensive phase.
    const mid = await checkControl();
    if (mid) return { outcome: mid };

    // 7. Run the director (Phase 3). On resume-after-answer the journal keeps
    //    prior progress; the director reads the full conversation including
    //    the user's answer.
    const workDir = path.join(storageRoot, 'projects', projectId, 'repo');
    const previousSummary =
      typeof journal['lastSummary'] === 'string' ? (journal['lastSummary'] as string) : null;

    const events: EventsOps = {
      questionAsked: async (rId, questionId, question, options) => {
        await appendEvent(pool, redactor, rId, AgentEventKind.QUESTION_ASKED, {
          questionId,
          question,
          options: options ?? [],
        });
      },
      toolCall: async (rId, toolName, args) => {
        await appendEvent(pool, redactor, rId, AgentEventKind.TOOL_CALL, {
          tool: toolName,
          args,
        });
      },
      toolResult: async (rId, toolName, ok, summary) => {
        await appendEvent(pool, redactor, rId, AgentEventKind.TOOL_RESULT, {
          tool: toolName,
          ok,
          summary,
        });
      },
    };

    await pool.query(
      `UPDATE agent_runs SET status = 'running', current_step = 'director' WHERE id = $1`,
      [runId],
    );
    await appendEvent(pool, redactor, runId, AgentEventKind.STATUS_CHANGED, {
      from: RunStatus.PLANNING,
      to: RunStatus.RUNNING,
    });

    // The user's latest message is the request; on resume, include the prior
    // summary so the fresh director turn continues instead of restarting blind.
    const { rows: msgRows } = await pool.query(
      `SELECT m.content FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1 AND m.role = 'user'
       ORDER BY m.created_at DESC LIMIT 1`,
      [projectId],
    );
    const firstMsg = msgRows[0] as { content: unknown } | undefined;
    const latestUserMessage =
      typeof firstMsg?.content === 'string' ? firstMsg.content : '';
    const userRequest = previousSummary
      ? `Previous progress summary:\n${previousSummary}\n\nLatest user message:\n${latestUserMessage}`
      : latestUserMessage || '(no user message found; inspect the project and propose a next step)';

    // Relevant memories (Phase 4): studio + project + run knowledge, ranked by
    // salience/recency/keyword overlap. Retrieval failure degrades to an empty
    // section — a run must never die because memory lookup failed. Minimal
    // seam: prompt-native injection via the request string, so runAgentJob's
    // signature is unchanged.
    const memoryStore = createPgMemoryStore(pool);
    let requestWithMemories = userRequest;
    try {
      const relevant = await relevanceRetrieve(memoryStore, {
        scope: 'all',
        projectId,
        runId,
        query: userRequest,
        limit: 8,
      });
      const section = formatMemoriesForPrompt(relevant);
      if (section) requestWithMemories = `${section}\n\nUser request:\n${userRequest}`;
    } catch (memErr) {
      logF('memory retrieval failed; continuing without memories', {
        error: memErr instanceof Error ? memErr.message : String(memErr),
      });
    }

    let result;
    try {
      const dbLike = {
        query: async (text: string, params?: unknown[]) => {
          const r = await pool.query(text, params as never[]);
          return { rows: r.rows as Array<Record<string, unknown>> };
        },
      };
      // Phase 4: the multi-agent orchestrator handles manual/auto/loop with
      // role agents, worktrees, blind review, and bounded correction.
      // runAgentJob (Phase 3 single director) remains as the tested fallback.
      const runMode = (
        afterClaim?.mode === 'manual' || afterClaim?.mode === 'loop' ? afterClaim.mode : 'auto'
      ) as 'manual' | 'auto' | 'loop';
      const { rows: projRows } = await pool.query(
        `SELECT last_good_build_id FROM projects WHERE id = $1`,
        [projectId],
      );
      const incumbent = projRows[0] as { last_good_build_id: string | null } | undefined;
      await appendEvent(pool, redactor, runId, AgentEventKind.DECISION, {
        decision: 'orchestrator_selected',
        runMode,
        orchestrator: 'multi-agent',
      });
      const multi = await runMultiAgentJob({
        runId,
        projectId,
        db: dbLike,
        queues,
        workDir,
        userRequest: requestWithMemories,
        provider,
        registry,
        evidence,
        events,
        memory: memoryStore,
        taskStore: createPgTaskStore(pool),
        runMode,
        incumbentBuildId: incumbent?.last_good_build_id ?? null,
        // Single-shot mode: bypass unreliable tool-calling, generate game as JSON.
        singleShot: true,
      });
      result = {
        summary: multi.summary,
        buildId: multi.buildId,
        buildStatus: multi.buildStatus,
        evidence: multi.evidence,
        stepsTaken: multi.stepsTaken,
        tokensUsed: multi.tokensUsed,
        tasks: multi.tasks,
        reviews: multi.reviews,
        loopIterations: multi.loopIterations,
        stopCode: multi.stopCode,
      };
    } catch (err) {
      if (isPauseForUser(err)) {
        // The director asked a durable question: park the run. The API's
        // POST /projects/:id/messages resumes it when the user answers.
        const waitingJournal = {
          ...journal,
          waitingFor: { questionId: err.questionId },
          ...(previousSummary ? { lastSummary: previousSummary } : {}),
        };
        await pool.query(
          `UPDATE agent_runs SET status = 'waiting_for_user', journal = $2,
             current_step = 'awaiting_user' WHERE id = $1`,
          [runId, JSON.stringify(waitingJournal)],
        );
        logF('run waiting for user', { questionId: err.questionId });
        return { outcome: 'waiting' };
      }
      if (err instanceof BudgetExhaustedError) {
        return await markFailed('budget_exhausted', err.message);
      }
      throw err;
    }

    // 8. Complete.
    const finalJournal = {
      ...journal,
      stepsDone: [...new Set([...done, 'director', 'complete'])],
      lastSummary: result.summary,
      lastBuildId: result.buildId,
      lastBuildStatus: result.buildStatus,
    };
    await pool.query(
      `UPDATE agent_runs
         SET status = 'completed', ended_at = now(), current_step = 'done', journal = $1
       WHERE id = $2`,
      [JSON.stringify(finalJournal), runId],
    );
    await appendEvent(pool, redactor, runId, AgentEventKind.COMPLETED, {
      summary: result.summary,
      buildId: result.buildId,
      buildStatus: result.buildStatus,
      stepsTaken: result.stepsTaken,
      tokensUsed: result.tokensUsed,
      tasks: result.tasks.map((t) => ({ id: t.id, role: t.role, status: t.status })),
      reviews: result.reviews.map((r) => ({ pick: r.pick, biggestGap: r.biggestGap })),
      loopIterations: result.loopIterations,
      stopCode: result.stopCode,
    });
    logF('run completed', { buildStatus: result.buildStatus });
    return { outcome: 'completed' };
  } catch (err) {
    // AgentCoreError → typed stop code → failed (not interrupted: the failure
    // is classified, resuming would repeat it).
    const code = toStopCode(err);
    if (code !== 'unknown') {
      const message = err instanceof Error ? err.message : String(err);
      return await markFailed(code, message);
    }
    // Unexpected failure: mark INTERRUPTED (not failed) so a human can resume.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await pool.query(
        "UPDATE agent_runs SET status = 'interrupted', error = $1 WHERE id = $2",
        [JSON.stringify({ code: 'interrupted', detail: message }), runId],
      );
      await appendEvent(pool, redactor, runId, AgentEventKind.ERROR, {
        code: 'interrupted',
        detail: message,
      });
    } catch (markErr) {
      logF('failed to mark run interrupted', {
        original: message,
        markError: markErr instanceof Error ? markErr.message : String(markErr),
      });
      throw err;
    }
    logF('run interrupted by unexpected error', { error: message });
    return { outcome: 'interrupted' };
  }
}
