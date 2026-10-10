/**
 * Multi-agent orchestration (Phase 4).
 *
 * Extends the single-director runAgentJob pattern WITHOUT breaking it:
 * runAgentJob keeps its exact signature and behavior; runMultiAgentJob adds
 * the orchestration layer on top and the worker chooses which to call.
 *
 * Flow:
 *  1. Director turn (director role prompt) with the dispatchTask tool.
 *     The director decomposes the objective and dispatches specialist tasks.
 *  2. Manual mode: askUser approval gate before building.
 *  3. Verify cycle: execBuild → poll → gatherEvidence → blindReview vs the
 *     incumbent (last-good) build.
 *  4. Bounded correction (max 3 rounds): reviewer's biggestGap → gameplay fix
 *     task → rebuild → re-review. Stops early on no measurable progress.
 *  5. Loop mode: improvement turns (director proposes the single most valuable
 *     next task) wrapped around verify cycles, while budgets remain AND
 *     progress is measurable AND no stop requested.
 *
 * Dispatch is SYNCHRONOUS in-process in Phase 4 (documented): each
 * dispatchTask call runs the role agent's full tool loop before returning.
 * BullMQ task fan-out is a Phase 7 scaling optimization; the TaskStore rows
 * and deterministic task IDs already make that migration safe.
 *
 * Every file write still goes through checkpoint-before-edit (the writeFile
 * tool owns it); every tool call emits events via EventsOps.
 */
import {
  BuildStatus,
  StopCode,
  createSecretRedactor,
  type SecretRedactor,
} from '@gameforge/shared';
import {
  BudgetTracker,
  type BudgetLimits,
  type CloudflareClient,
  type ModelRegistry,
  type ChatMessage,
} from '@gameforge/model-providers';
import { AgentCoreError, AgentCoreErrorCode, isPauseForUser } from './errors.js';
import {
  createGitOps,
  ensureGitRepo,
} from './git.js';
import {
  createWorktree,
  discardWorktree,
  mergeWorktree,
} from './worktrees.js';
import {
  blindReview,
  type BlindReviewResult,
  type ReviewCandidate,
} from './review.js';
import {
  createTask,
  type AgentTask,
  type TaskStatus,
  type TaskStore,
} from './tasks.js';
import { getRoleDef, type AgentRole } from './roles.js';
import {
  executeToolCall,
  toolDefsForRole,
  type BuildsOps,
  type EvidenceProvider,
  type EvidenceSummary,
  type EventsOps,
  type TaskDispatcherOps,
  type TaskDispatchResult,
  type ToolContext,
} from './tools.js';
import type { MemoryStore } from './memory.js';
import { runAgentTurn } from './director.js';
import type { DbLike, QueuesLike } from './jobIntegration.js';

export type RunMode = 'manual' | 'auto' | 'loop';

export interface MultiAgentJobOptions {
  runId: string;
  projectId: string;
  db: DbLike;
  queues: QueuesLike;
  workDir: string;
  userRequest: string;
  provider: CloudflareClient;
  registry: ModelRegistry;
  budgets?: BudgetLimits;
  evidence: EvidenceProvider;
  events: EventsOps;
  redactor?: SecretRedactor;
  memory: MemoryStore;
  taskStore: TaskStore;
  buildPollIntervalMs?: number;
  buildTimeoutMs?: number;
  runMode?: RunMode;
  /** Build ID of the incumbent (last-good) build for blind review. */
  incumbentBuildId?: string | null;
  /** Acceptance criteria text for the reviewer. */
  criteria?: string[];
  maxCorrectionRounds?: number;
  maxLoopIterations?: number;
  history?: ChatMessage[];
  shouldAbort?: () => Promise<StopCode | null>;
}

export interface MultiAgentJobResult {
  summary: string;
  buildId: string | null;
  buildStatus: BuildStatus | null;
  evidence: EvidenceSummary | null;
  stepsTaken: number;
  tokensUsed: number;
  tasks: AgentTask[];
  reviews: BlindReviewResult[];
  loopIterations: number;
  stopCode: StopCode | null;
}

const TERMINAL_BUILD: ReadonlySet<BuildStatus> = new Set([
  BuildStatus.VERIFIED,
  BuildStatus.PARTIAL,
  BuildStatus.FAILED,
  BuildStatus.CANCELED,
]);

const MAX_CORRECTION_ROUNDS = 3;
const MAX_LOOP_ITERATIONS = 5;
const ROLE_TURN_MAX_ROUNDS = 20;

/** Verdict rank for measurable-progress comparison. Higher is better. */
export function verdictRank(v: BuildStatus | null | undefined): number {
  switch (v) {
    case BuildStatus.VERIFIED:
      return 2;
    case BuildStatus.PARTIAL:
      return 1;
    default:
      return 0;
  }
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

interface OrchestratorDeps {
  opts: MultiAgentJobOptions;
  budgets: BudgetTracker;
  builds: BuildsOps;
  baseCtx: ToolContext;
  git: ReturnType<typeof createGitOps>;
  redactor: SecretRedactor;
}

/** Build the synchronous in-process task dispatcher bound to this run. */
function createDispatcher(deps: OrchestratorDeps): TaskDispatcherOps {
  const { opts, budgets, baseCtx, git, redactor } = deps;
  const { runId, workDir, taskStore, provider, registry, events } = opts;

  return {
    dispatch: async (
      role: AgentRole,
      objective: string,
      dependsOn: string[] = [],
    ): Promise<TaskDispatchResult> => {
      // Fail closed on unknown roles before touching the store.
      getRoleDef(role);

      // Dependency gate: every dep must exist and be completed.
      for (const depId of dependsOn) {
        const dep = await taskStore.get(depId);
        if (!dep || dep.status !== 'completed') {
          throw new AgentCoreError(
            AgentCoreErrorCode.DEPENDENCY_FAILED,
            `dispatchTask: dependency ${depId} is not completed`,
            StopCode.INTERRUPTED,
            { role, depId },
          );
        }
      }

      const task = createTask(runId, role, objective, dependsOn);

      // Deterministic IDs → resume, never replay: a completed task with the
      // same ID returns its cached summary.
      const existing = await taskStore.get(task.id).catch(() => null);
      if (existing?.status === 'completed') {
        const out = (existing.output ?? {}) as { summary?: string };
        return {
          taskId: task.id,
          status: 'completed',
          summary: typeof out.summary === 'string' ? out.summary : '(cached)',
        };
      }
      if (existing && existing.status !== 'failed' && existing.status !== 'canceled') {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
          `dispatchTask: task ${task.id} already ${existing.status}`,
          StopCode.TOOL_PERMISSION_DENIED,
          { taskId: task.id },
        );
      }
      await taskStore.create(task);
      await taskStore.setStatus(task.id, 'running');
      await events.toolCall(runId, 'dispatchTask', {
        taskId: task.id,
        role,
        objective: objective.slice(0, 300),
      });

      // Reviewer/QA read the main tree; builders get an isolated worktree.
      const useWorktree = role !== 'reviewer' && role !== 'qa';
      let wt: string | null = null;
      try {
        let roleCtx: ToolContext = { ...baseCtx, role };
        if (useWorktree) {
          wt = await createWorktree(workDir, runId, task.id);
          roleCtx = { ...baseCtx, role, workDir: wt, git: createGitOps(wt) };
        }
        const { runRoleTurn } = await import('./director.js');
        const res = await runRoleTurn({
          runId,
          workDir: roleCtx.workDir,
          ctx: roleCtx,
          provider,
          registry,
          budgets,
          role,
          objective,
          maxRounds: ROLE_TURN_MAX_ROUNDS,
          shouldAbort: opts.shouldAbort,
        });
        await taskStore.setStatus(task.id, 'completed', { summary: res.summary });
        if (useWorktree && wt) {
          // F8: checkpoint the main tree before merging the task branch in.
          await git.checkpoint(`before merge task ${task.id}`);
          await mergeWorktree(workDir, runId, task.id, true);
        }
        await events.toolResult(runId, 'dispatchTask', true, res.summary.slice(0, 300));
        return { taskId: task.id, status: 'completed', summary: res.summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await taskStore.setStatus(task.id, 'failed', {
          error: redactor.redactText(msg).slice(0, 1000),
        });
        await events.toolResult(runId, 'dispatchTask', false, msg.slice(0, 300));
        throw err; // typed propagation — the director sees the failure
      } finally {
        // The task branch is KEPT (recoverable after merge conflicts);
        // only the worktree checkout is removed.
        if (wt) await discardWorktree(workDir, wt).catch(() => undefined);
      }
    },
  };
}

interface VerifyCycle {
  buildId: string;
  verdict: BuildStatus;
  evidence: EvidenceSummary | null;
  review: BlindReviewResult | null;
}

export async function runMultiAgentJob(
  opts: MultiAgentJobOptions,
): Promise<MultiAgentJobResult> {
  const redactor = opts.redactor ?? createSecretRedactor();
  const runMode: RunMode = opts.runMode ?? 'auto';
  const maxCorrectionRounds = opts.maxCorrectionRounds ?? MAX_CORRECTION_ROUNDS;
  const maxLoopIterations = opts.maxLoopIterations ?? MAX_LOOP_ITERATIONS;
  const criteria = opts.criteria ?? [];

  await ensureGitRepo(opts.workDir);
  const git = createGitOps(opts.workDir);
  const budgets = new BudgetTracker(opts.budgets ?? {});

  const builds: BuildsOps = {
    enqueue: async () => {
      const revisionSha = await git.head();
      return opts.queues.enqueueBuild(opts.projectId, opts.runId, revisionSha);
    },
    status: (buildId) => opts.queues.getBuildStatus(buildId),
  };

  const baseCtx: ToolContext = {
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

  const deps: OrchestratorDeps = { opts, budgets, builds, baseCtx, git, redactor };
  const dispatcher = createDispatcher(deps);
  const directorCtx: ToolContext = { ...baseCtx, dispatcher };

  let stepsTaken = 0;
  const reviews: BlindReviewResult[] = [];
  let stopCode: StopCode | null = null;

  const directorDef = getRoleDef('director');

  // ---- 1. Director turn: decompose + dispatch specialist tasks. ----
  const directorTurn = await runAgentTurn({
    runId: opts.runId,
    workDir: opts.workDir,
    ctx: directorCtx,
    provider: opts.provider,
    registry: opts.registry,
    budgets,
    systemPrompt: directorDef.systemPrompt,
    toolDefs: toolDefsForRole('director'),
    modelRole: directorDef.modelRole,
    requiresTools: directorDef.requiresTools,
    // Director plans and reasons: prefer the most capable model available.
    preferLargeModel: true,
    objective: opts.userRequest,
    history: opts.history,
    shouldAbort: opts.shouldAbort,
  });
  stepsTaken += directorTurn.stepsTaken;
  await opts.events.toolCall(opts.runId, 'directorTurn', {
    stepsTaken: directorTurn.stepsTaken,
    finished: directorTurn.finished,
  });

  if (directorTurn.stepsTaken === 0) {
    // The director produced no actions at all: fail honestly instead of
    // building an empty worktree and reporting a misleading "completed" run.
    throw new AgentCoreError(
      AgentCoreErrorCode.DIRECTOR_IDLE,
      'Director finished its turn with 0 tool calls: no tasks were dispatched and no files were touched. Failing the run instead of building nothing.',
      StopCode.NO_MEASURABLE_PROGRESS,
      { stepsTaken: directorTurn.stepsTaken },
    );
  }

  // ---- 2. Manual mode: approval gate before any build. ----
  if (runMode === 'manual') {
    await executeToolCall(
      'askUser',
      {
        question:
          'The director has finished planning and dispatching tasks. Approve the build & verification phase?',
        options: ['Approve and build', 'Make changes', 'Stop'],
      },
      directorCtx,
    );
    // askUser throws PauseForUser → propagates to the worker (waiting_for_user).
  }

  // ---- 3-5. Verify cycles (build → evidence → review → bounded correction). ----
  const pollMs = opts.buildPollIntervalMs ?? 5000;
  const timeoutMs = opts.buildTimeoutMs ?? 600_000;

  // Incumbent evidence for blind review (best effort — never fails the run).
  let incumbentEvidence: EvidenceSummary | null = null;
  if (opts.incumbentBuildId) {
    try {
      incumbentEvidence = await opts.evidence.gather(opts.incumbentBuildId);
    } catch {
      incumbentEvidence = null;
    }
  }

  async function verifyCycle(): Promise<VerifyCycle> {
    const execRes = (await executeToolCall('execBuild', {}, directorCtx)) as {
      buildId: string;
    };
    const final = await pollBuild(builds, execRes.buildId, pollMs, timeoutMs);
    let evidence: EvidenceSummary | null = null;
    if (final.status === BuildStatus.VERIFIED || final.status === BuildStatus.PARTIAL) {
      try {
        evidence = await directorCtx.evidence.gather(execRes.buildId);
      } catch {
        evidence = null;
      }
    }
    let review: BlindReviewResult | null = null;
    if (incumbentEvidence && evidence) {
      const candidateA: ReviewCandidate = {
        label: 'A',
        buildId: execRes.buildId,
        verdict: final.status,
        evidence,
      };
      const candidateB: ReviewCandidate = {
        label: 'B',
        buildId: opts.incumbentBuildId ?? 'incumbent',
        verdict: 'verified',
        evidence: incumbentEvidence,
      };
      review = await blindReview({
        provider: opts.provider,
        registry: opts.registry,
        budgets,
        candidateA,
        candidateB,
        criteria,
        incumbentLabel: 'B', // never sent to the reviewer — structural blindness
      });
      reviews.push(review);
      await opts.events.toolCall(opts.runId, 'blindReview', {
        buildId: execRes.buildId,
        pick: review.pick,
        biggestGap: review.biggestGap,
        keptIncumbent: review.keptIncumbent,
      });
    }
    return { buildId: execRes.buildId, verdict: final.status, evidence, review };
  }

  /** Measurable progress: verdict rank up, or review flipped to the candidate. */
  function progressed(prev: VerifyCycle | null, curr: VerifyCycle): boolean {
    if (!prev) return true;
    if (verdictRank(curr.verdict) > verdictRank(prev.verdict)) return true;
    if (prev.review && curr.review) {
      return prev.review.pick === 'B' && curr.review.pick === 'A';
    }
    return false;
  }

  async function correctionLoop(first: VerifyCycle): Promise<VerifyCycle> {
    let current = first;
    let previous: VerifyCycle | null = null;
    for (let round = 1; round <= maxCorrectionRounds; round++) {
      const needsFix =
        current.verdict === BuildStatus.FAILED ||
        (current.review !== null && current.review.pick !== 'A');
      if (!needsFix) break;
      if (!progressed(previous, current) && previous !== null) {
        stopCode = StopCode.NO_MEASURABLE_PROGRESS;
        break;
      }
      const gap =
        current.review?.biggestGap ??
        `build ${current.buildId} failed with verdict ${current.verdict}`;
      const evidenceNote = current.evidence
        ? ` Evidence: ${current.evidence.screenshots} screenshots, ${current.evidence.consoleErrors} console errors, blank=${current.evidence.blankDetected}.`
        : '';
      // Bounded fix task. The role agent fixes FILES ONLY — the orchestrator
      // owns the build, so the objective forbids execBuild (no double builds).
      await dispatcher.dispatch(
        'gameplay',
        `Fix the game. Reviewer biggest gap: ${gap}.${evidenceNote} ` +
          `Make the smallest targeted fix in the project files. ` +
          `Do NOT call execBuild or buildStatus — the orchestrator builds after your fix. ` +
          `Finish with finishRun summarizing the fix.`,
      );
      previous = current;
      current = await verifyCycle();
    }
    return current;
  }

  let cycle = await verifyCycle();
  let loopIterations = 1;
  cycle = await correctionLoop(cycle);

  // ---- 5. Loop mode: improvement turns while progress is measurable. ----
  if (runMode === 'loop') {
    let previous: VerifyCycle | null = null;
    while (loopIterations < maxLoopIterations) {
      if (!progressed(previous, cycle) && previous !== null) {
        stopCode = StopCode.NO_MEASURABLE_PROGRESS;
        break;
      }
      previous = cycle;

      // Improvement turn: the director proposes ONE next improvement.
      let dispatches = 0;
      const countingDispatcher: TaskDispatcherOps = {
        dispatch: async (role, objective, dependsOn) => {
          dispatches += 1;
          return dispatcher.dispatch(role, objective, dependsOn);
        },
      };
      const loopCtx: ToolContext = { ...baseCtx, dispatcher: countingDispatcher };
      const evidenceNote = cycle.evidence
        ? `Screenshots: ${cycle.evidence.screenshots}, console errors: ${cycle.evidence.consoleErrors}, blank: ${cycle.evidence.blankDetected}.`
        : 'No evidence gathered.';
      const reviewNote =
        cycle.review != null
          ? `Blind review pick: ${cycle.review.pick}; biggest gap: ${cycle.review.biggestGap}.`
          : 'No blind review (no incumbent).';
      const improvement = await runAgentTurn({
        runId: opts.runId,
        workDir: opts.workDir,
        ctx: loopCtx,
        provider: opts.provider,
        registry: opts.registry,
        budgets,
        systemPrompt: directorDef.systemPrompt,
        toolDefs: toolDefsForRole('director'),
        modelRole: directorDef.modelRole,
        requiresTools: directorDef.requiresTools,
        objective:
          `Loop iteration ${loopIterations + 1}. Latest build ${cycle.buildId}: verdict ${cycle.verdict}. ` +
          `${evidenceNote} ${reviewNote} ` +
          `Dispatch the single most valuable improvement as ONE dispatchTask (small scope), ` +
          `or call finishRun with "no further improvements" if the game is complete. ` +
          `Do NOT build yourself.`,
        shouldAbort: opts.shouldAbort,
      });
      stepsTaken += improvement.stepsTaken;

      if (dispatches === 0) break; // director considers the game done
      loopIterations += 1;
      cycle = await verifyCycle();
      cycle = await correctionLoop(cycle);
    }
    if (loopIterations >= maxLoopIterations) {
      stopCode = stopCode ?? StopCode.ITERATION_BUDGET_EXHAUSTED;
    }
  }

  // ---- 6. Assemble the result. ----
  const tasks = await opts.taskStore.list(opts.runId);
  const evidenceNote = cycle.evidence
    ? ` Evidence: ${cycle.evidence.screenshots} screenshots, ${cycle.evidence.consoleErrors} console errors, blank=${cycle.evidence.blankDetected}.`
    : '';
  const reviewNote =
    cycle.review != null
      ? ` Blind review: pick ${cycle.review.pick} (${cycle.review.biggestGap}).`
      : '';
  const summary =
    `${directorTurn.summary}\n\nFinal build ${cycle.buildId}: ${cycle.verdict}.${evidenceNote}${reviewNote}` +
    (stopCode ? ` Stop: ${stopCode}.` : '') +
    ` Tasks: ${tasks.filter((t) => t.status === 'completed').length}/${tasks.length} completed.`;

  return {
    summary: summary.trim(),
    buildId: cycle.buildId,
    buildStatus: cycle.verdict,
    evidence: cycle.evidence,
    stepsTaken,
    tokensUsed: budgets.snapshot().usedTokens,
    tasks,
    reviews,
    loopIterations,
    stopCode,
  };
}
