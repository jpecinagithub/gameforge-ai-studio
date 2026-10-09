/**
 * Typed errors for @gameforge/agent-core.
 *
 * Genex discipline, adopted: behavior is decided by these codes, never by
 * matching English text in messages. Callers switch on `code`.
 */
import { StopCode } from '@gameforge/shared';

export const AgentCoreErrorCode = {
  UNKNOWN_TOOL: 'unknown_tool',
  TOOL_VALIDATION_FAILED: 'tool_validation_failed',
  TOOL_EXECUTION_FAILED: 'tool_execution_failed',
  /** Optimistic-concurrency conflict: expectedCommitSha did not match HEAD. */
  CONFLICT: 'conflict',
  /** The director exceeded its per-turn tool-call round budget. */
  ITERATION_BUDGET_EXHAUSTED: 'iteration_budget_exhausted',
  /** External abort requested (pause/cancel) via the shouldAbort hook. */
  ABORTED: 'aborted',
  GIT_FAILED: 'git_failed',
  /** Task dependency graph contains a cycle (Phase 4 orchestration). */
  CYCLIC_DEPENDENCY: 'cyclic_dependency',
  /** A task was dispatched before its dependencies completed. */
  DEPENDENCY_FAILED: 'dependency_failed',
  /** Git worktree merge hit conflicts; conflicting paths listed in detail. */
  MERGE_CONFLICT: 'merge_conflict',
} as const;
export type AgentCoreErrorCode =
  (typeof AgentCoreErrorCode)[keyof typeof AgentCoreErrorCode];

export class AgentCoreError extends Error {
  readonly code: AgentCoreErrorCode;
  /** Corresponding orchestration-level stop code for run finalization. */
  readonly stopCode: StopCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: AgentCoreErrorCode,
    message: string,
    stopCode: StopCode = StopCode.UNKNOWN,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentCoreError';
    this.code = code;
    this.stopCode = stopCode;
    this.detail = detail;
  }
}

/**
 * Control-flow signal: the director needs a human answer before it can
 * continue. This is TYPED control flow — never an Error with a matched
 * message. Thrown by the `askUser` tool; the director rethrows it untouched;
 * the worker maps it to `waiting_for_user`.
 */
export class PauseForUser {
  readonly code = 'pause_for_user' as const;
  readonly questionId: string;

  constructor(questionId: string) {
    this.questionId = questionId;
  }
}

export function isPauseForUser(v: unknown): v is PauseForUser {
  return v instanceof PauseForUser;
}

/** Map an AgentCoreError to the run-level stop code the worker should record. */
export function toStopCode(err: unknown): StopCode {
  if (err instanceof AgentCoreError) return err.stopCode;
  return StopCode.UNKNOWN;
}
