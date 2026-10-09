/**
 * Per-run budget enforcement (ARCHITECTURE.md §7).
 *
 * Groq is always metered, so budgets are load-bearing architecture, not an edge
 * case. The tracker is fed per-completion usage; exceeding any configured limit
 * throws a typed BudgetExhaustedError naming the broken budget (typed codes,
 * never English matching at the call site).
 */
import { BudgetExhaustedError, BudgetKind } from './errors.js';

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallclockMs?: number;
  /** Epoch ms the run started. Defaults to construction time. */
  startedAt?: number;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no known price — counts toward tokens, not cost. */
  costUsd: number | null;
}

export interface BudgetSnapshot {
  usedTokens: number;
  usedCostUsd: number;
  elapsedMs: number;
  limits: BudgetLimits;
}

/**
 * Fallback token estimate when the API omits usage (chars/4 heuristic).
 * Callers must prefer real usage numbers; this exists only so a missing
 * usage block cannot silently bypass the token budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class BudgetTracker {
  private readonly limits: BudgetLimits;
  private readonly startedAt: number;
  private usedTokens = 0;
  private usedCostUsd = 0;

  constructor(limits: BudgetLimits = {}) {
    this.limits = { ...limits };
    this.startedAt = limits.startedAt ?? Date.now();
  }

  /** Record one completion's usage; throws BudgetExhaustedError on breach. */
  recordUsage(delta: UsageDelta): BudgetSnapshot {
    if (delta.inputTokens < 0 || delta.outputTokens < 0) {
      throw new RangeError('recordUsage: token counts must be non-negative');
    }
    this.usedTokens += delta.inputTokens + delta.outputTokens;
    if (delta.costUsd !== null) this.usedCostUsd += delta.costUsd;

    if (this.limits.maxTokens !== undefined && this.usedTokens > this.limits.maxTokens) {
      throw new BudgetExhaustedError(
        BudgetKind.TOKENS,
        `used ${this.usedTokens} tokens exceeds max ${this.limits.maxTokens}`,
      );
    }
    if (
      this.limits.maxCostUsd !== undefined &&
      this.usedCostUsd > this.limits.maxCostUsd
    ) {
      throw new BudgetExhaustedError(
        BudgetKind.COST,
        `used $${this.usedCostUsd.toFixed(4)} exceeds max $${this.limits.maxCostUsd.toFixed(4)}`,
      );
    }
    this.checkTime();
    return this.snapshot();
  }

  /** Throw if the wall clock is spent. Call between agent turns. */
  checkTime(now: number = Date.now()): void {
    if (
      this.limits.maxWallclockMs !== undefined &&
      now - this.startedAt > this.limits.maxWallclockMs
    ) {
      throw new BudgetExhaustedError(
        BudgetKind.WALLCLOCK,
        `elapsed ${now - this.startedAt}ms exceeds max ${this.limits.maxWallclockMs}ms`,
      );
    }
  }

  snapshot(now: number = Date.now()): BudgetSnapshot {
    return {
      usedTokens: this.usedTokens,
      usedCostUsd: this.usedCostUsd,
      elapsedMs: now - this.startedAt,
      limits: { ...this.limits },
    };
  }
}
