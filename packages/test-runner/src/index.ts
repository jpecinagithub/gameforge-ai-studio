export { serveGame, injectShim, SHIM_ROUTE } from './pageServer.js';
export type { PageServer, PageServerOptions } from './pageServer.js';

export {
  gatherEvidence,
  computePixelStats,
  classifyEvidenceFailure,
} from './evidence.js';
export type {
  BrowserLike,
  BrowserPageLike,
  ConsoleEntry,
  FailedRequest,
  PageErrorEntry,
  ScriptAction,
  GatherEvidenceOptions,
  PixelStats,
  ShotEvidence,
  StateSnapshot,
  EvidenceReport,
  EvidenceClassification,
} from './evidence.js';

export { runBuildPipeline, DEFAULT_PHASES } from './pipeline.js';
export type {
  Phase,
  PhaseContext,
  PhaseResult,
  PhaseStatus,
  RunnerLike,
  BuildStore,
  BuildRecord,
  AcceptanceCriterion,
  StudioJson,
  RunBuildOptions,
  BuildPipelineResult,
} from './pipeline.js';
export { runVisualReview, verifyVisionModel } from './visualReview.js';
export type {
  VisionShot,
  VisionCriterionInput,
  VisionModelVerification,
  VisualReviewDeps,
  VisualReviewOutcome,
  SavedReviewRow,
} from './visualReview.js';
