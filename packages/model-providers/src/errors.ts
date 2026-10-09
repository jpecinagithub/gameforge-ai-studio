/**
 * Typed errors for the model-providers package.
 *
 * Genex discipline, adopted: behavior is decided by these codes, never by
 * matching English text in messages. Every error carries { code, retryable }.
 */

export const GroqErrorCode = {
  RATE_LIMITED: 'rate_limited',
  MODEL_NOT_FOUND: 'model_not_found',
  TIMEOUT: 'timeout',
  BAD_RESPONSE: 'bad_response',
  NETWORK_ERROR: 'network_error',
  AUTH_ERROR: 'auth_error',
  BAD_REQUEST: 'bad_request',
  MODEL_UNAVAILABLE: 'model_unavailable',
  BUDGET_EXHAUSTED: 'budget_exhausted',
} as const;
export type GroqErrorCode =
  (typeof GroqErrorCode)[keyof typeof GroqErrorCode];

export interface GroqErrorOptions {
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

export class GroqError extends Error {
  readonly code: GroqErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: GroqErrorCode, message: string, opts: GroqErrorOptions = {}) {
    super(message);
    this.name = 'GroqError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) {
      // Keep the cause chain without stringifying secrets into the message.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/** Thrown when no registered model satisfies a role's capability requirements. */
export class ModelUnavailableError extends GroqError {
  readonly missingCapability: string;

  constructor(missingCapability: string, detail: string) {
    super(
      GroqErrorCode.MODEL_UNAVAILABLE,
      `No active Groq model provides required capability "${missingCapability}". ${detail}`,
      { retryable: false },
    );
    this.name = 'ModelUnavailableError';
    this.missingCapability = missingCapability;
  }
}

export const BudgetKind = {
  TOKENS: 'tokens',
  COST: 'cost',
  WALLCLOCK: 'wallclock',
} as const;
export type BudgetKind = (typeof BudgetKind)[keyof typeof BudgetKind];

/** Thrown by BudgetTracker when a run budget is exceeded. */
export class BudgetExhaustedError extends GroqError {
  readonly budget: BudgetKind;

  constructor(budget: BudgetKind, detail: string) {
    super(
      GroqErrorCode.BUDGET_EXHAUSTED,
      `Budget exhausted (${budget}): ${detail}`,
      { retryable: false },
    );
    this.name = 'BudgetExhaustedError';
    this.budget = budget;
  }
}
