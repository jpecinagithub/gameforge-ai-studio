/**
 * Typed vocabularies. Genex discipline, adopted: never decide behavior by matching
 * English text — every status, code and kind is a typed constant. Unknown values
 * fail closed at parse time (zod enums in schemas.ts).
 */

/** Execution modes (§8 of master prompt). */
export const ExecutionMode = {
  MANUAL: 'manual',
  AUTO: 'auto',
  LOOP: 'loop',
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Durable run states (§9). Terminal states are COMPLETED/FAILED/CANCELED. */
export const RunStatus = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  RUNNING: 'running',
  WAITING_FOR_USER: 'waiting_for_user',
  BUILDING: 'building',
  TESTING: 'testing',
  REVIEWING: 'reviewing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  INTERRUPTED: 'interrupted',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELED,
]);

/** Agent roles (§7). */
export const AgentRole = {
  DIRECTOR: 'director',
  GAMEPLAY: 'gameplay',
  SCENE_VISUAL: 'scene_visual',
  UI: 'ui',
  ASSET: 'asset',
  QA: 'qa',
  REVIEWER: 'reviewer',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/** Per-task states. */
export const TaskStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Typed stop codes (adapted from Genex `loop/outcomes.ts` StopCode, MIT).
 * Code-decided, never phrase-matched.
 */
export const StopCode = {
  BUDGET_EXHAUSTED: 'budget_exhausted',
  TOKEN_BUDGET_EXHAUSTED: 'token_budget_exhausted',
  COST_BUDGET_EXHAUSTED: 'cost_budget_exhausted',
  TIME_BUDGET_EXHAUSTED: 'time_budget_exhausted',
  ITERATION_BUDGET_EXHAUSTED: 'iteration_budget_exhausted',
  NO_MEASURABLE_PROGRESS: 'no_measurable_progress',
  INVALID_RESPONSE: 'invalid_response',
  USER_STOPPED: 'user_stopped',
  USER_PAUSED: 'user_paused',
  CANCELED: 'canceled',
  CIRCUIT_BREAKER: 'circuit_breaker',
  RATE_LIMITED: 'rate_limited',
  ENGINE_EXHAUSTED: 'engine_exhausted',
  MODEL_UNAVAILABLE: 'model_unavailable',
  CONTEXT_OVERFLOW: 'context_overflow',
  TOOL_PERMISSION_DENIED: 'tool_permission_denied',
  PLUGIN_CONSENT_DECLINED: 'plugin_consent_declined',
  BUILD_FAILED: 'build_failed',
  TEST_FAILED: 'test_failed',
  VERIFICATION_FAILED: 'verification_failed',
  JUDGE_DOWN: 'judge_down',
  OBSERVATION_DOWN: 'observation_down',
  RUNNER_DOWN: 'runner_down',
  EXTERNAL_BLOCKER: 'external_blocker',
  INTERRUPTED: 'interrupted',
  UNKNOWN: 'unknown',
} as const;
export type StopCode = (typeof StopCode)[keyof typeof StopCode];

/** Build verdicts (§11). A finished worker, passing checks, integration and the live
 * revision are distinct facts — verdicts never merge them. */
export const BuildStatus = {
  QUEUED: 'queued',
  BUILDING: 'building',
  TESTING: 'testing',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;
export type BuildStatus = (typeof BuildStatus)[keyof typeof BuildStatus];

/** Append-only agent event kinds (§9, §20). */
export const AgentEventKind = {
  RUN_CREATED: 'run_created',
  STATUS_CHANGED: 'status_changed',
  DECISION: 'decision',
  PLAN_UPDATED: 'plan_updated',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  MODEL_CALL: 'model_call',
  QUESTION_ASKED: 'question_asked',
  QUESTION_ANSWERED: 'question_answered',
  BUILD_STARTED: 'build_started',
  BUILD_FINISHED: 'build_finished',
  TEST_RESULT: 'test_result',
  REVIEW_RESULT: 'review_result',
  ARTIFACT_SAVED: 'artifact_saved',
  ERROR: 'error',
  RETRY: 'retry',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
} as const;
export type AgentEventKind = (typeof AgentEventKind)[keyof typeof AgentEventKind];

/** Asset usage ladder (adapted from Genex F9): a delivered file is never evidence
 * the game uses it. */
export const AssetUseStage = {
  UNCONFIRMED: 'unconfirmed',
  INTEGRATED: 'integrated',
  VERIFIED: 'verified',
} as const;
export type AssetUseStage = (typeof AssetUseStage)[keyof typeof AssetUseStage];

/** Asset generation providers. */
export const AssetProvider = {
  PROCEDURAL: 'procedural',
  BLENDER: 'blender',
  IMPORT: 'import',
  UPLOAD: 'upload',
} as const;
export type AssetProvider = (typeof AssetProvider)[keyof typeof AssetProvider];

/** Asset generation job states. */
export const AssetGenerationStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;
export type AssetGenerationStatus =
  (typeof AssetGenerationStatus)[keyof typeof AssetGenerationStatus];

/** Plugin install states (adapted from Genex F10). */
export const PluginInstallState = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  NOT_ENABLED: 'not-enabled',
} as const;
export type PluginInstallState =
  (typeof PluginInstallState)[keyof typeof PluginInstallState];

/** Game kinds (adapted from Genex `loop/kinds.ts`). */
export const GameKind = {
  FIRST_PERSON: 'first-person',
  THIRD_PERSON: 'third-person',
  TOP_DOWN: 'top-down',
  SIDE_2D: 'side-2d',
  RACING: 'racing',
  FLIGHT: 'flight',
  STATIC_BOARD: 'static-board',
  FREE_CAMERA: 'free-camera',
} as const;
export type GameKind = (typeof GameKind)[keyof typeof GameKind];

/** Review verdict per criterion (§16). */
export const ReviewResultValue = {
  PASS: 'pass',
  FAIL: 'fail',
  UNVERIFIED: 'unverified',
} as const;
export type ReviewResultValue =
  (typeof ReviewResultValue)[keyof typeof ReviewResultValue];

/** Model capability keys for the live registry (§2). */
export const ModelCapability = {
  CONTEXT_WINDOW: 'context_window',
  SUPPORTS_TOOLS: 'supports_tools',
  SUPPORTS_VISION: 'supports_vision',
  SUPPORTS_JSON_MODE: 'supports_json_mode',
  MAX_OUTPUT_TOKENS: 'max_output_tokens',
} as const;
export type ModelCapability =
  (typeof ModelCapability)[keyof typeof ModelCapability];

/**
 * Self-improvement proposal scopes (§6). The scope bounds what "apply" is
 * allowed to do — apply semantics are honest per scope:
 * - prompt: stages a CANDIDATE row in skill_versions (never activates).
 * - config: writes application_settings (rollbackable).
 * - code: stores the diff for manual review; code is NEVER auto-executed.
 */
export const ImprovementScope = {
  PROMPT: 'prompt',
  CONFIG: 'config',
  CODE: 'code',
} as const;
export type ImprovementScope =
  (typeof ImprovementScope)[keyof typeof ImprovementScope];

/** Proposal lifecycle. Auto-apply is OFF by design: apply requires a prior human approval. */
export const ImprovementStatus = {
  PROPOSED: 'proposed',
  APPROVED: 'approved',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  ROLLED_BACK: 'rolled_back',
} as const;
export type ImprovementStatus =
  (typeof ImprovementStatus)[keyof typeof ImprovementStatus];
