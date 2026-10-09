import type {
  AgentRun,
  ApiErrorShape,
  Asset,
  AssetPage,
  BuildArtifact,
  BuildJob,
  ChatMessage,
  ExecutionModeValue,
  ModelCapabilities,
  ModelInfo,
  Project,
  ProjectPage,
  ReviewResult,
  RevisionPage,
  SettingsMap,
  TestResult,
} from '../types';

/**
 * Typed REST client for /api/v1.
 * Base URL comes from VITE_API_URL (build-time env); no secrets ever leave here —
 * the browser holds no API keys by design.
 */

function baseUrl(): string {
  const v = import.meta.env.VITE_API_URL as string | undefined;
  return (v && v.replace(/\/+$/, '')) || 'http://127.0.0.1:8090';
}

export class ApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, body: ApiErrorShape) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.requestId = body.error.requestId;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/v1${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    // Network-level failure (backend down, DNS, CORS): surface a typed error.
    throw new ApiError(0, {
      error: { code: 'network_error', message: 'network_error', requestId: 'n/a' },
    });
  }
  if (!res.ok) {
    let body: ApiErrorShape | null = null;
    try {
      body = (await res.json()) as ApiErrorShape;
    } catch {
      /* non-JSON error body */
    }
    if (body && typeof body.error?.code === 'string') {
      throw new ApiError(res.status, body);
    }
    throw new ApiError(res.status, {
      error: {
        code: 'unknown_error',
        message: `HTTP ${res.status}`,
        requestId: 'n/a',
      },
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/* ---------- Projects ---------- */

export interface CreateProjectInput {
  name: string;
  description?: string;
  template: string;
  kind?: string;
  engine?: string;
}

export const listProjects = (page = 1, pageSize = 50): Promise<ProjectPage> =>
  get<ProjectPage>(`/projects?page=${page}&pageSize=${pageSize}`);

export const getProject = (id: string): Promise<Project> =>
  get<Project>(`/projects/${encodeURIComponent(id)}`);

export const createProject = (input: CreateProjectInput): Promise<Project> =>
  post<Project>('/projects', input);

/* ---------- Messages ---------- */

export interface PostMessageInput {
  content: string;
  startRun?: { mode: ExecutionModeValue };
}

export const listMessages = (projectId: string): Promise<ChatMessage[]> =>
  get<ChatMessage[]>(`/projects/${encodeURIComponent(projectId)}/messages`);

export const postMessage = (
  projectId: string,
  input: PostMessageInput,
): Promise<ChatMessage> =>
  post<ChatMessage>(`/projects/${encodeURIComponent(projectId)}/messages`, {
    role: 'user',
    ...input,
  });

/* ---------- Runs ---------- */

export const listRuns = (projectId: string): Promise<AgentRun[]> =>
  get<AgentRun[]>(`/projects/${encodeURIComponent(projectId)}/runs`);

export const createRun = (
  projectId: string,
  mode: ExecutionModeValue,
): Promise<AgentRun> =>
  post<AgentRun>(`/projects/${encodeURIComponent(projectId)}/runs`, { mode });

export const pauseRun = (runId: string): Promise<AgentRun> =>
  post<AgentRun>(`/runs/${encodeURIComponent(runId)}/pause`);

export const resumeRun = (runId: string): Promise<AgentRun> =>
  post<AgentRun>(`/runs/${encodeURIComponent(runId)}/resume`);

export const cancelRun = (runId: string): Promise<AgentRun> =>
  post<AgentRun>(`/runs/${encodeURIComponent(runId)}/cancel`);

/* ---------- Builds ---------- */

export const listBuilds = (projectId: string): Promise<BuildJob[]> =>
  get<BuildJob[]>(`/projects/${encodeURIComponent(projectId)}/builds`);

export const getBuild = (buildId: string): Promise<BuildJob> =>
  get<BuildJob>(`/builds/${encodeURIComponent(buildId)}`);

/* ---------- Build diagnostics ---------- */

export const getBuildTests = (buildId: string): Promise<TestResult[]> =>
  get<TestResult[]>(`/builds/${encodeURIComponent(buildId)}/tests`);

export const getBuildReviews = (buildId: string): Promise<ReviewResult[]> =>
  get<ReviewResult[]>(`/builds/${encodeURIComponent(buildId)}/reviews`);

export const getBuildArtifacts = (buildId: string): Promise<BuildArtifact[]> =>
  get<BuildArtifact[]>(`/builds/${encodeURIComponent(buildId)}/artifacts`);

export const artifactDownloadUrl = (artifactId: string): string =>
  `${baseUrl()}/api/v1/artifacts/${encodeURIComponent(artifactId)}/download`;

/* ---------- Revisions ---------- */

export const listRevisions = (
  projectId: string,
  page = 1,
  pageSize = 50,
): Promise<RevisionPage> =>
  get<RevisionPage>(
    `/projects/${encodeURIComponent(projectId)}/revisions?page=${page}&pageSize=${pageSize}`,
  );

/* ---------- Assets ---------- */

export const listAssets = (
  projectId: string,
  page = 1,
  pageSize = 50,
): Promise<AssetPage> =>
  get<AssetPage>(
    `/projects/${encodeURIComponent(projectId)}/assets?page=${page}&pageSize=${pageSize}`,
  );

/**
 * Upload an asset file (multipart POST /projects/:id/assets → 201).
 * `kind` is optional: omitted lets the backend infer it from the extension.
 * Multipart needs a raw fetch (the JSON `request` helper always sets
 * Content-Type: application/json).
 */
export async function uploadAsset(
  projectId: string,
  file: File,
  kind?: string,
): Promise<Asset> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl()}/api/v1/projects/${encodeURIComponent(projectId)}/assets${query}`,
      { method: 'POST', body: form },
    );
  } catch {
    throw new ApiError(0, {
      error: { code: 'network_error', message: 'network_error', requestId: 'n/a' },
    });
  }
  if (!res.ok) {
    let body: ApiErrorShape | null = null;
    try {
      body = (await res.json()) as ApiErrorShape;
    } catch {
      /* non-JSON error body */
    }
    if (body && typeof body.error?.code === 'string') {
      throw new ApiError(res.status, body);
    }
    throw new ApiError(res.status, {
      error: {
        code: 'unknown_error',
        message: `HTTP ${res.status}`,
        requestId: 'n/a',
      },
    });
  }
  return (await res.json()) as Asset;
}

/** Delete an asset (DELETE /assets/:id → 204). */
export async function deleteAsset(assetId: string): Promise<void> {
  await request<void>(`/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
}

export const assetDownloadUrl = (assetId: string): string =>
  `${baseUrl()}/api/v1/assets/${encodeURIComponent(assetId)}/download`;

/* ---------- Settings ---------- */

export const getSettings = (): Promise<SettingsMap> => get<SettingsMap>('/settings');

const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const patchSettings = (body: Record<string, unknown>): Promise<SettingsMap> =>
  patch<SettingsMap>('/settings', body);

/* ---------- Models ---------- */

export const listModels = (): Promise<{ items: ModelInfo[] }> =>
  get<{ items: ModelInfo[] }>('/models');

export const getModelCapabilities = (): Promise<ModelCapabilities> =>
  get<ModelCapabilities>('/models/capabilities');

/** Backend base URL (read-only display; never a secret). */
export const apiBaseUrl = (): string => baseUrl();

export const eventsUrl = (runId: string, lastEventId?: string): string => {
  const q = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : '';
  return `${baseUrl()}/api/v1/runs/${encodeURIComponent(runId)}/events${q}`;
};
