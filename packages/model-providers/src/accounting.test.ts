import { describe, expect, it } from 'vitest';
import { computeCost, PRICES, toUsageRecord } from './accounting.js';

describe('computeCost', () => {
  it('computes cost for a priced model', () => {
    const price = PRICES['openai/gpt-oss-120b'];
    expect(price).toBeDefined();
    const cost = computeCost('openai/gpt-oss-120b', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(price.inputPerM + price.outputPerM, 10);
  });

  it('returns null for unknown models — never guessed', () => {
    expect(computeCost('some/unlisted-model', 1000, 1000)).toBeNull();
  });

  it('every price row is date-stamped', () => {
    for (const [modelId, price] of Object.entries(PRICES)) {
      expect(price.asOf, modelId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.inputPerM).toBeGreaterThan(0);
      expect(price.outputPerM).toBeGreaterThan(0);
    }
  });
});

describe('toUsageRecord', () => {
  it('resolves cost via the price table', () => {
    const rec = toUsageRecord({
      runId: 'run_1',
      taskId: null,
      role: 'director',
      modelId: 'openai/gpt-oss-120b',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1200,
    });
    expect(rec.costUsd).not.toBeNull();
    expect(rec.runId).toBe('run_1');
  });

  it('leaves cost null for unpriced models', () => {
    const rec = toUsageRecord({
      runId: null,
      taskId: null,
      role: 'qa',
      modelId: 'unknown/model',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 10,
    });
    expect(rec.costUsd).toBeNull();
  });
});
