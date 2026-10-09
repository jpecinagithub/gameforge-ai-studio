import { describe, expect, it } from 'vitest';
import { computeCost, toUsageRecord, WORKERS_AI_FREE_NEURONS_PER_DAY } from './accounting.js';

describe('computeCost', () => {
  it('always returns null — Workers AI prices live in the dashboard, never invented', () => {
    expect(computeCost('@cf/meta/llama-3.1-8b-instruct', 1_000_000, 1_000_000)).toBeNull();
    expect(computeCost('some/unlisted-model', 1000, 1000)).toBeNull();
  });

  it('documents the free-tier neuron allowance', () => {
    expect(WORKERS_AI_FREE_NEURONS_PER_DAY).toBe(10_000);
  });
});

describe('toUsageRecord', () => {
  it('builds a record with null cost (unknown, never guessed)', () => {
    const rec = toUsageRecord({
      runId: 'run_1',
      taskId: null,
      role: 'director',
      modelId: '@cf/meta/llama-3.1-8b-instruct',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1200,
    });
    expect(rec.costUsd).toBeNull();
    expect(rec.runId).toBe('run_1');
    expect(rec.inputTokens).toBe(100);
    expect(rec.outputTokens).toBe(50);
  });
});
