/**
 * Token cost accounting (ARCHITECTURE.md §7, DATABASE.md §1.18).
 *
 * Genex evals discipline, adopted: unknown prices are reported as unavailable
 * (null), never guessed. The price table is DATE-STAMPED data — re-verify
 * against https://groq.com/pricing before relying on it for real billing.
 * Every entry carries its own asOf so stale rows are visible.
 */
import type { AgentRole } from '@gameforge/shared';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** ISO date this row was last verified. */
  asOf: string;
}

/**
 * Curated 2026-10-09. RE-VERIFY before production use — Groq changes prices.
 * Models absent here → computeCost returns null (unknown, never guessed).
 */
export const PRICES: Record<string, ModelPrice> = {
  'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.75, asOf: '2026-10-09' },
  'openai/gpt-oss-20b': { inputPerM: 0.075, outputPerM: 0.3, asOf: '2026-10-09' },
  'llama-3.3-70b-versatile': { inputPerM: 0.59, outputPerM: 0.79, asOf: '2026-10-09' },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    inputPerM: 0.11,
    outputPerM: 0.34,
    asOf: '2026-10-09',
  },
  'meta-llama/llama-4-maverick-17b-128e-instruct': {
    inputPerM: 0.2,
    outputPerM: 0.6,
    asOf: '2026-10-09',
  },
  'qwen/qwen3-32b': { inputPerM: 0.29, outputPerM: 0.59, asOf: '2026-10-09' },
};

/** USD cost for a completion, or null when the model has no verified price. */
export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES[modelId];
  if (!price) return null; // unknown → unavailable, never guessed
  return (
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM
  );
}

/** One row for the model_usage table (DATABASE.md §1.18). */
export interface UsageRecord {
  runId: string | null;
  taskId: string | null;
  role: AgentRole | string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

/** Build a UsageRecord from a completion; cost resolved via the price table. */
export function toUsageRecord(input: {
  runId: string | null;
  taskId: string | null;
  role: AgentRole | string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}): UsageRecord {
  return {
    ...input,
    costUsd: computeCost(input.modelId, input.inputTokens, input.outputTokens),
  };
}
