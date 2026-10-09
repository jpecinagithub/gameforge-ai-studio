/**
 * runAgentJob — the Phase 3 replacement for the worker's scaffold plan.
 *
 * Contract with apps/worker (which KEEPS all of this):
 * - claim (queued → planning, atomic), pause / resume / cancel checks,
 *   interrupted-marking on unexpected throws, event appending.
 *
 * What runAgentJob owns:
 * 1. ensure the git repo exists in workDir,
 * 2. load conversation history (project memory for the director),
 * 3. run ONE director turn (tool loop),
 * 4. final build pass via the execBuild tool (unless the director already
 *    built and verified — the tool loop is the source of truth; this pass
 *    guarantees the run never ends without a build verdict),
 * 5. gather evidence on verified/partial builds,
 * 6. return the final summary.
 *
 * Typed propagation: PauseForUser (→ waiting_for_user), BudgetExhaustedError
 * (→ failed, budget code), AgentCoreError (→ failed/interrupted by stopCode).
 * This function never swallows them.
 */
import {
  BuildStatus,
  createSecretRedactor,
  type SecretRedactor,
} from '@gameforge/shared';
import type { ChatMessage } from '@gameforge/model-providers';
import {
  BudgetTracker,
  type BudgetLimits,
  type GroqClient,
  type ModelRegistry,
} from '@gameforge/model-providers';
import { runDirectorTurn } from './director.js';
import { createGitOps, ensureGitRepo } from './git.js';
import {
  executeToolCall,
  type BuildsOps,
  type EvidenceProvider,
  type EvidenceSummary,
  type EventsOps,
  type ToolContext,
} from './tools.js';
import type { MemoryStore } from './memory.js';

/** Minimal DB surface (worker passes its pg pool). */
export interface DbLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Minimal queue surface (worker passes BullMQ-backed impl). */
export interface QueuesLike {
  enqueueBuild(
    projectId: string,
    runId: string,
    revisionSha: string,
  ): Promise<{ buildId: string }>;
  getBuildStatus(
    buildId: string,
  ): Promise<{ status: BuildStatus; verdict?: unknown }>;
}

export interface AgentJobOptions {
  runId: string;
  projectId: string;
  db: DbLike;
  queues: QueuesLike;
  workDir: string;
  userRequest: string;
  groq: GroqClient;
  registry: ModelRegistry;
  budgets?: BudgetLimits;
  evidence: EvidenceProvider;
  events: EventsOps;
  redactor?: SecretRedactor;
  /** Durable memory store (worker provides the pg implementation). */
  memory: MemoryStore;
  buildPollIntervalMs?: number;
  buildTimeoutMs?: number;
}

export interface AgentJobResult {
  summary: string;
  buildId: string | null;
  buildStatus: BuildStatus | null;
  evidence: EvidenceSummary | null;
  stepsTaken: number;
  tokensUsed: number;
}

const TERMINAL_BUILD: ReadonlySet<BuildStatus> = new Set([
  BuildStatus.VERIFIED,
  BuildStatus.PARTIAL,
  BuildStatus.FAILED,
  BuildStatus.CANCELED,
]);

/** Last 20 user/assistant messages of the project's latest conversation. */
async function loadConversationContext(
  db: DbLike,
  projectId: string,
): Promise<ChatMessage[]> {
  const conv = await db.query(
    `SELECT id FROM conversations WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [projectId],
  );
  const convId = conv.rows[0]?.['id'];
  if (typeof convId !== 'string') return [];
  const msgs = await db.query(
    `SELECT role, content FROM messages
      WHERE conversation_id = $1 AND role IN ('user','assistant','system')
      ORDER BY created_at DESC LIMIT 20`,
    [convId],
  );
  return msgs.rows
    .reverse()
    .filter(
      (r): r is { role: 'user' | 'assistant' | 'system'; content: string } =>
        typeof r['content'] === 'string' &&
        (r['role'] === 'user' || r['role'] === 'assistant' || r['role'] === 'system'),
    )
    .map((r) => ({ role: r.role, content: r.content }));
}

async function pollBuild(
  builds: BuildsOps,
  buildId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<{ status: BuildStatus; verdict?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await builds.status(buildId);
    if (TERMINAL_BUILD.has(s.status)) return s;
    if (Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function runAgentJob(opts: AgentJobOptions): Promise<AgentJobResult> {
  const redactor = opts.redactor ?? createSecretRedactor();

  // 1. Git repo (claim already done by the worker).
  await ensureGitRepo(opts.workDir);
  const git = createGitOps(opts.workDir);

  // 2. Conversation context = lightweight project memory for the director.
  const history = await loadConversationContext(opts.db, opts.projectId);

  // 3. Budgets (load-bearing: Groq is always metered).
  const budgets = new BudgetTracker(opts.budgets ?? {});

  // 4. Tool context wiring worker-owned services.
  const builds: BuildsOps = {
    enqueue: async () => {
      const revisionSha = await git.head();
      return opts.queues.enqueueBuild(opts.projectId, opts.runId, revisionSha);
    },
    status: (buildId) => opts.queues.getBuildStatus(buildId),
  };
  const ctx: ToolContext = {
    runId: opts.runId,
    projectId: opts.projectId,
    role: 'director',
    workDir: opts.workDir,
    git,
    builds,
    evidence: opts.evidence,
    events: opts.events,
    redactor,
    memory: opts.memory,
  };

  // 5. Director turn. PauseForUser / BudgetExhaustedError / AgentCoreError
  //    propagate typed — the worker maps them to run states.
  const turn = await runDirectorTurn({
    runId: opts.runId,
    workDir: opts.workDir,
    ctx,
    groq: opts.groq,
    registry: opts.registry,
    budgets,
    userRequest: opts.userRequest,
    history,
  });

  await opts.events.toolCall(opts.runId, 'directorTurn', {
    stepsTaken: turn.stepsTaken,
    finished: turn.finished,
  });

  // 6. Final build pass via tools — guarantees a build verdict even if the
  //    director never called execBuild itself.
  const execRes = (await executeToolCall('execBuild', {}, ctx)) as { buildId: string };
  const buildId = execRes.buildId;
  const final = await pollBuild(
    builds,
    buildId,
    opts.buildPollIntervalMs ?? 5000,
    opts.buildTimeoutMs ?? 600_000,
  );

  // 7. Evidence on verified/partial builds.
  let evidence: EvidenceSummary | null = null;
  if (final.status === BuildStatus.VERIFIED || final.status === BuildStatus.PARTIAL) {
    evidence = await ctx.evidence.gather(buildId);
  }

  const evidenceNote = evidence
    ? ` Evidence: ${evidence.screenshots} screenshots, ${evidence.consoleErrors} console errors, blank=${evidence.blankDetected}.`
    : '';
  const summary =
    `${turn.summary}\n\nFinal build ${buildId}: ${final.status}.${evidenceNote}`.trim();

  return {
    summary,
    buildId,
    buildStatus: final.status,
    evidence,
    stepsTaken: turn.stepsTaken,
    tokensUsed: turn.tokensUsed,
  };
}
