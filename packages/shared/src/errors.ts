/**
 * API error envelope (§23). Every error response has this shape; `code` is typed,
 * `message` is human-readable and never contains secrets.
 */
export const ApiErrorCode = {
  BAD_REQUEST: 'bad_request',
  VALIDATION_FAILED: 'validation_failed',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  BINARY_FILE: 'binary_file',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  MODEL_UNAVAILABLE: 'model_unavailable',
  RUNNER_UNAVAILABLE: 'runner_unavailable',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  NOT_IMPLEMENTED: 'not_implemented',
  FORBIDDEN: 'forbidden',
  REQUEST_TIMEOUT: 'request_timeout',
  INTERNAL: 'internal_error',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Machine-readable detail; never secrets. */
    detail?: Record<string, unknown>;
    /** Stable request id for log correlation. */
    requestId: string;
  };
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  detail?: Record<string, unknown>,
): ApiErrorBody {
  return { error: { code, message, requestId, ...(detail ? { detail } : {}) } };
}

/** Pagination envelope. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function page<T>(items: T[], total: number, p: number, ps: number): Page<T> {
  return { items, page: p, pageSize: ps, total };
}
