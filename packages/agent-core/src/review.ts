/**
 * Blind reviewer (Phase 4).
 *
 * A FRESH-context judge: it sees only the two candidates' evidence summaries
 * plus the acceptance criteria — never conversation history, never which
 * candidate is the incumbent. It returns a pick and the single biggest gap of
 * the loser. Never numeric scores (they drift — Genex blind-review discipline).
 *
 * Contract rules (typed, never phrase-matched):
 * - Garbled/unparseable verdict → KEEP THE INCUMBENT (pick = incumbentLabel,
 *   biggestGap = 'unparseable verdict; incumbent kept'). Never tie, never
 *   defect to the challenger on a garbled verdict.
 * - Blindness is structural: the prompt payload contains no incumbent label.
 * - Retries bounded: at most `maxAttempts` LLM calls (default 2).
 */
import { StopCode } from '@gameforge/shared';
import {
  computeCost,
  type BudgetTracker,
  type CloudflareClient,
  type ModelRegistry,
  type ChatMessage,
} from '@gameforge/model-providers';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import { getRoleDef } from './roles.js';
import type { EvidenceSummary } from './tools.js';

export interface ReviewCandidate {
  /** 'A' or 'B' — the reviewer never learns which is the incumbent. */
  label: 'A' | 'B';
  buildId: string;
  verdict: string;
  evidence: EvidenceSummary;
  notes?: string;
}

export interface BlindReviewResult {
  pick: 'A' | 'B';
  biggestGap: string;
  notes: string;
  /** True when the verdict was garbled and the incumbent was kept. */
  keptIncumbent: boolean;
  attempts: number;
}

export interface BlindReviewOptions {
  provider: CloudflareClient;
  registry: ModelRegistry;
  budgets: BudgetTracker;
  candidateA: ReviewCandidate;
  candidateB: ReviewCandidate;
  criteria: string[];
  /** Which label is the incumbent — NEVER sent to the reviewer. */
  incumbentLabel: 'A' | 'B';
  maxAttempts?: number;
}

const REVIEWER_SYSTEM_PROMPT = getRoleDef('reviewer').systemPrompt;

function candidateBlock(c: ReviewCandidate): string {
  const e = c.evidence;
  return (
    `CANDIDATE ${c.label}:\n` +
    `- build: ${c.buildId} (verdict: ${c.verdict})\n` +
    `- screenshots: ${e.screenshots}, console errors: ${e.consoleErrors}, blank detected: ${e.blankDetected}\n` +
    `- evidence notes: ${(e.notes ?? []).join('; ') || '(none)'}\n` +
    `- candidate notes: ${c.notes ?? '(none)'}`
  );
}

/** Build the reviewer messages. Exported so tests can assert blindness. */
export function buildReviewMessages(
  candidateA: ReviewCandidate,
  candidateB: ReviewCandidate,
  criteria: string[],
): ChatMessage[] {
  const criteriaText =
    criteria.length > 0
      ? criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '(no explicit criteria — judge playability and correctness)';
  return [
    { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Two build candidates were produced for the same game. Compare them BLIND ` +
        `against the acceptance criteria below, using only the evidence shown. ` +
        `You do not know which candidate is currently live; judge the evidence alone.\n\n` +
        `${candidateBlock(candidateA)}\n\n${candidateBlock(candidateB)}\n\n` +
        `ACCEPTANCE CRITERIA:\n${criteriaText}\n\n` +
        `Reply with EXACTLY this JSON and nothing else:\n` +
        `{"pick": "A"|"B", "biggestGap": "<single sentence: the loser's biggest gap>", "notes": "<brief justification>"}`,
    },
  ];
}

interface ParsedVerdict {
  pick: 'A' | 'B';
  biggestGap: string;
  notes: string;
}

/** Extract the verdict JSON from model output; null when garbled. */
export function parseVerdict(text: string | null): ParsedVerdict | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (v['pick'] !== 'A' && v['pick'] !== 'B') return null;
    if (typeof v['biggestGap'] !== 'string' || v['biggestGap'].length === 0) return null;
    return {
      pick: v['pick'],
      biggestGap: v['biggestGap'],
      notes: typeof v['notes'] === 'string' ? v['notes'] : '',
    };
  } catch {
    return null;
  }
}

export async function blindReview(opts: BlindReviewOptions): Promise<BlindReviewResult> {
  const {
    provider,
    registry,
    budgets,
    candidateA,
    candidateB,
    criteria,
    incumbentLabel,
    maxAttempts = 2,
  } = opts;

  if (candidateA.label !== 'A' || candidateB.label !== 'B') {
    throw new AgentCoreError(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
      'blindReview: candidates must be labeled A and B',
      StopCode.TOOL_PERMISSION_DENIED,
    );
  }

  // Capability-gated model selection — no model names here.
  const model = registry.selectModel({
    role: getRoleDef('reviewer').modelRole,
    requiresTools: false,
    requiresJsonMode: true,
  });
  const messages = buildReviewMessages(candidateA, candidateB, criteria);

  let attempts = 0;
  let lastError: string | null = null;
  while (attempts < maxAttempts) {
    attempts += 1;
    budgets.checkTime();
    const res = await provider.chatCompletions({ model, messages });
    const costUsd = computeCost(model, res.usage.inputTokens, res.usage.outputTokens);
    budgets.recordUsage({
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd,
    });

    const parsed = parseVerdict(res.content);
    if (parsed) {
      return {
        pick: parsed.pick,
        biggestGap: parsed.biggestGap,
        notes: parsed.notes,
        keptIncumbent: false,
        attempts,
      };
    }
    lastError = (res.content ?? '').slice(0, 200);
    // Garbled verdict: retry (bounded). The final fallback keeps the incumbent.
  }

  // Garbled verdict after all attempts — KEEP THE INCUMBENT. Never tie,
  // never defect to the challenger on an unparseable verdict.
  return {
    pick: incumbentLabel,
    biggestGap: 'unparseable verdict; incumbent kept',
    notes: lastError ? `Reviewer output unparseable after ${attempts} attempts: ${lastError}` : 'Reviewer output unparseable.',
    keptIncumbent: true,
    attempts,
  };
}
