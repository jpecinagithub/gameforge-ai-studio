/** DTOs mirroring the backend /api/v1 contract (ARCHITECTURE.md §8). */

export type RunStatusValue =
  | 'queued' | 'planning' | 'running' | 'waiting_for_user' | 'building'
  | 'testing' | 'reviewing' | 'completed' | 'failed' | 'canceled' | 'interrupted';

export type BuildStatusValue =
  | 'queued' | 'building' | 'testing' | 'verifying'
  | 'verified' | 'partial' | 'failed' | 'canceled';

export type ExecutionModeValue = 'manual' | 'auto' | 'loop';

export interface Project {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  template: string;
  kind?: string | null;
  engine: string;
  status: 'active' | 'archived';
  updated_at: string;
  created_at: string;
}

export interface ProjectPage {
  items: Project[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AgentRun {
  id: string;
  project_id: string;
  mode: ExecutionModeValue;
  status: RunStatusValue;
  current_step?: string | null;
  created_at: string;
}

export interface BuildJob {
  id: string;
  project_id: string;
  /** Null when the build failed before producing a revision. */
  revision_sha: string | null;
  status: BuildStatusValue;
  /** Served preview URL for this build's artifact (preview origin). Set when available. */
  preview_url?: string | null;
  verdict?: {
    summary?: string;
    failed_phase?: string;
    acceptance?: Array<{ criterion: string; result: string }>;
    /** Phase outcomes persisted by the build pipeline (Phase 3+). */
    phases?: Array<{ name: string; status: 'pass' | 'fail' | 'skip'; error?: string | null }>;
  } | null;
  created_at: string;
}

/** Project asset row (mirrors GET /api/v1/projects/:id/assets). */
export interface Asset {
  id: string;
  /** Storage-relative path; the file name is its basename. */
  path: string;
  kind: string;
  format?: string | null;
  bytes: number;
  contentHash?: string | null;
  source?: string | null;
  /** Asset usage ladder: unconfirmed | integrated | verified. */
  useStage?: string | null;
  /** Real download URL served by GET /api/v1/assets/:id/download. */
  url?: string | null;
  createdAt: string;
}

export interface AssetPage {
  items: Asset[];
  page: number;
  pageSize: number;
  total: number;
}

/** Project revision row (mirrors GET /api/v1/projects/:id/revisions, newest-first). */
export interface Revision {
  id: string;
  sha: string;
  message?: string | null;
  author: string;
  checkpointKind?: string | null;
  healthy: boolean;
  createdAt: string;
}

export interface RevisionPage {
  items: Revision[];
  page: number;
  pageSize: number;
  total: number;
}

/** Test result row (mirrors GET /api/v1/builds/:id/tests). */
export interface TestResult {
  suite?: string | null;
  name: string;
  status: string;
  durationMs?: number | null;
  details?: unknown;
  createdAt: string;
}

/** Review result row (mirrors GET /api/v1/builds/:id/reviews). */
export interface ReviewResult {
  criterion: string;
  result: string;
  confidence?: number | null;
  evidence?: unknown;
  issue?: string | null;
  recommendation?: string | null;
  retestRequired?: boolean | null;
  judgeModel?: string | null;
  createdAt: string;
}

/** Build artifact (mirrors GET /api/v1/builds/:id/artifacts). */
export interface BuildArtifact {
  id: string;
  kind: string;
  name: string;
  size?: number | null;
  url: string;
  createdAt: string;
}

/** GET /api/v1/settings returns a flat key→value object. */
export type SettingsMap = Record<string, unknown>;

export interface ModelInfo {
  modelId: string;
  displayName: string;
  capabilities: unknown;
  lastSeenAt?: string | null;
}

export interface ModelCapabilities {
  capabilityKeys: string[];
  agentRoles: string[];
  provider: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

export interface AgentEvent {
  id: number;
  run_id: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ApiErrorShape {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
    requestId: string;
  };
}
