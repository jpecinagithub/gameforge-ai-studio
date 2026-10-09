import { ApiError, apiBaseUrl } from './client';

/**
 * Typed REST client for project files (Phase 5 editor backend contract).
 *
 * GET /api/v1/projects/:id/files          → { files: [{ path, size, modifiedAt }] }
 * GET /api/v1/projects/:id/files/*path    → { path, content, sha } | 400 binary_file
 * PUT /api/v1/projects/:id/files/*path    → { path, sha, commitSha } | 409 conflict (+ currentSha)
 *
 * Optimistic concurrency: keep the `sha` from GET and pass it as
 * `expectedSha`. A 409 throws ConflictError carrying the server's currentSha;
 * the UI then offers reload / overwrite / diff.
 */

function filesBaseUrl(): string {
  return apiBaseUrl();
}

function encodeFilePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export interface ProjectFileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

export interface SaveFileResult {
  path: string;
  sha: string;
  commitSha: string;
}

export class ConflictError extends Error {
  readonly currentSha: string;

  constructor(currentSha: string) {
    super('conflict');
    this.name = 'ConflictError';
    this.currentSha = currentSha;
  }
}

async function fileRequest<T>(projectId: string, filePath: string, init?: RequestInit): Promise<T> {
  const url = `${filesBaseUrl()}/api/v1/projects/${encodeURIComponent(
    projectId,
  )}/files/${encodeFilePath(filePath)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, {
      error: { code: 'network_error', message: 'network_error', requestId: 'n/a' },
    });
  }
  if (res.status === 409) {
    // Optimistic-concurrency conflict: currentSha rides at the top level.
    let currentSha = '';
    try {
      const body = (await res.json()) as { currentSha?: string };
      if (typeof body.currentSha === 'string') currentSha = body.currentSha;
    } catch {
      /* ignore */
    }
    throw new ConflictError(currentSha);
  }
  if (!res.ok) {
    let body: { error?: { code?: string } } | null = null;
    try {
      body = (await res.json()) as { error?: { code?: string } };
    } catch {
      /* non-JSON error body */
    }
    const code =
      body && typeof body.error?.code === 'string' ? body.error.code : 'unknown_error';
    throw new ApiError(res.status, {
      error: { code, message: code, requestId: 'n/a' },
    });
  }
  return (await res.json()) as T;
}

export const listFiles = async (projectId: string): Promise<ProjectFileEntry[]> => {
  const res = await fetch(
    `${filesBaseUrl()}/api/v1/projects/${encodeURIComponent(projectId)}/files`,
  );
  if (!res.ok) {
    throw new ApiError(res.status, {
      error: { code: 'unknown_error', message: `HTTP ${res.status}`, requestId: 'n/a' },
    });
  }
  const body = (await res.json()) as { files: ProjectFileEntry[] };
  return body.files;
};

export const getFile = (projectId: string, path: string): Promise<FileContent> =>
  fileRequest<FileContent>(projectId, path);

export const saveFile = (
  projectId: string,
  path: string,
  content: string,
  expectedSha?: string,
): Promise<SaveFileResult> =>
  fileRequest<SaveFileResult>(projectId, path, {
    method: 'PUT',
    body: JSON.stringify(
      expectedSha === undefined ? { content } : { content, expectedSha },
    ),
  });
