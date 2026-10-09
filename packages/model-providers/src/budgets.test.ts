import { describe, expect, it } from 'vitest';
import { BudgetTracker, estimateTokens } from './budgets.js';
import { BudgetExhaustedError, BudgetKind } from './errors.js';

describe('estimateTokens', () => {
  it('estimates ceil(chars/4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(9))).toBe(3);
  });
});

describe('BudgetTracker', () => {
  it('records usage without throwing under limits', () => {
    const t = new BudgetTracker({ maxTokens: 1000, maxCostUsd: 1, maxWallclockMs: 60_000 });
    const snap = t.recordUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    expect(snap.usedTokens).toBe(150);
    expect(snap.usedCostUsd).toBeCloseTo(0.01);
  });

  it('throws naming the token budget when exceeded', () => {
    const t = new BudgetTracker({ maxTokens: 100 });
    const err = (() => {
      try {
        t.recordUsage({ inputTokens: 60, outputTokens: 50, costUsd: null });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).budget).toBe(BudgetKind.TOKENS);
    expect((err as Error).message).toContain('tokens');
  });

  it('throws naming the cost budget when exceeded', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.5 });
    const err = (() => {
      try {
        t.recordUsage({ inputTokens: 10, outputTokens: 10, costUsd: 0.75 });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).budget).toBe(BudgetKind.COST);
    expect((err as Error).message).toContain('cost');
  });

  it('null cost never trips the cost budget', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.5 });
    expect(() =>
      t.recordUsage({ inputTokens: 10, outputTokens: 10, costUsd: null }),
    ).not.toThrow();
  });

  it('checkTime throws naming the wallclock budget', () => {
    const t = new BudgetTracker({ maxWallclockMs: 1000, startedAt: Date.now() - 5000 });
    const err = (() => {
      try {
        t.checkTime();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).budget).toBe(BudgetKind.WALLCLOCK);
  });

  it('rejects negative token counts', () => {
    const t = new BudgetTracker();
    expect(() =>
      t.recordUsage({ inputTokens: -1, outputTokens: 0, costUsd: null }),
    ).toThrow(RangeError);
  });
});
