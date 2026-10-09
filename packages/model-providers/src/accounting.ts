/**
 * Usage accounting (ARCHITECTURE.md §7, DATABASE.md §1.18).
 *
 * Cloudflare Workers AI bills in NEURONS, not dollars-per-token. The free
 * tier grants 10,000 neurons per day per account (as of 2026-10-09). Exact
 * pricing beyond the free tier lives in the Cloudflare dashboard.
 *
 * Genex evals discipline, adopted: unknown prices are reported as unavailable
 * (null), never guessed. computeCost therefore always returns null — the
 * cost budget stays configured but inert until a verified price source is
 * wired. Token and wall-clock budgets remain fully load-bearing.
 */
import type { AgentRole } from '@gameforge/shared';

/** Free-tier allowance, documented (not enforced — Cloudflare enforces it). */
export const WORKERS_AI_FREE_NEURONS_PER_DAY = 10_000;

/**
 * USD cost for a completion. Always null: Workers AI prices live in the
 * Cloudflare dashboard and are never invented here.
 */
export function computeCost(
  _modelId: string,
  _inputTokens: number,
  _outputTokens: number,
): number | null {
  return null; // unknown → unavailable, never guessed
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
