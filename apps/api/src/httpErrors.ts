import { ApiErrorCode } from '@gameforge/shared';

/** Typed HTTP error. Routes throw these; server.ts maps them to the envelope. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const binaryFile = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(400, ApiErrorCode.BINARY_FILE, message, detail);

export const badRequest = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(400, ApiErrorCode.BAD_REQUEST, message, detail);

export const validationFailed = (detail: Record<string, unknown>) =>
  new HttpError(400, ApiErrorCode.VALIDATION_FAILED, 'Request validation failed', detail);

export const notFound = (what: string) =>
  new HttpError(404, ApiErrorCode.NOT_FOUND, `${what} not found`);

export const conflict = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(409, ApiErrorCode.CONFLICT, message, detail);

export const payloadTooLarge = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(413, ApiErrorCode.PAYLOAD_TOO_LARGE, message, detail);

export const dependencyUnavailable = (message: string) =>
  new HttpError(503, ApiErrorCode.DEPENDENCY_UNAVAILABLE, message);

export const notImplemented = (message: string) =>
  new HttpError(501, ApiErrorCode.NOT_IMPLEMENTED, message);

export const forbidden = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(403, ApiErrorCode.FORBIDDEN, message, detail);
