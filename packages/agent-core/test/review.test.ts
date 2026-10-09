/**
 * Blind reviewer tests (Phase 4).
 *
 * - Parses a well-formed verdict (pick + biggest gap, no scores).
 * - Garbled verdict → KEEPS THE INCUMBENT (never ties, never defects).
 * - Blindness is structural: the prompt payload never names the incumbent.
 * - Retries are bounded (maxAttempts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExhaustedError,
  BudgetTracker,
  type ChatCompletionsResult,
  type GroqClient,
  type ModelRegistry,
} from '@gameforge/model-providers';
import {
  blindReview,
  buildReviewMessages,
  parseVerdict,
  type ReviewCandidate,
} from '../src/review.js';
import type { EvidenceSummary } from '../src/tools.js';

function scriptedGroq(contents: Array<string | null>): GroqClient {
  const queue = [...contents];
  const groq = {
    chatCompletions: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('script exhausted');
      const res: ChatCompletionsResult = {
        content: next,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'mock-model',
        latencyMs: 1,
      };
      return res;
    }),
  } as unknown as GroqClient;
  return groq;
}

const registry = { selectModel: () => 'mock-model' } as unknown as ModelRegistry;

function evidence(over: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    buildId: 'build_x',
    screenshots: 2,
    consoleErrors: 0,
    blankDetected: false,
    notes: [],
    ...over,
  };
}

function candidate(label: 'A' | 'B', over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    label,
    buildId: `build_${label}`,
    verdict: 'verified',
    evidence: evidence({ buildId: `build_${label}` }),
    ...over,
  };
}

function reviewOpts(
  groq: GroqClient,
  extra: Record<string, unknown> = {},
) {
  return {
    groq,
    registry,
    budgets: new BudgetTracker({}),
    candidateA: candidate('A'),
    candidateB: candidate('B'),
    criteria: ['Game boots without errors', 'Player can move'],
    incumbentLabel: 'B' as const,
    ...extra,
  };
}

describe('parseVerdict', () => {
  it('parses a well-formed verdict', () => {
    const v = parseVerdict('{"pick": "A", "biggestGap": "B has no sound", "notes": "ok"}');
    expect(v).toEqual({ pick: 'A', biggestGap: 'B has no sound', notes: 'ok' });
  });

  it('extracts JSON embedded in prose', () => {
    const v = parseVerdict('Here is my verdict:\n{"pick":"B","biggestGap":"A is blank","notes":"x"}\nDone.');
    expect(v?.pick).toBe('B');
  });

  it('returns null for garbled output', () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict('I like both equally!')).toBeNull();
    expect(parseVerdict('{"pick": "C", "biggestGap": "x"}')).toBeNull();
    expect(parseVerdict('{"pick": "A"}')).toBeNull(); // missing biggestGap
    expect(parseVerdict('not json at all')).toBeNull();
  });
});

describe('blindReview', () => {
  it('returns the parsed pick and biggest gap', async () => {
    const groq = scriptedGroq([
      '{"pick": "A", "biggestGap": "B crashes on boot", "notes": "A is playable"}',
    ]);
    const res = await blindReview(reviewOpts(groq));
    expect(res.pick).toBe('A');
    expect(res.biggestGap).toBe('B crashes on boot');
    expect(res.keptIncumbent).toBe(false);
    expect(res.attempts).toBe(1);
  });

  it('keeps the incumbent on a garbled verdict (never ties, never defects)', async () => {
    const groq = scriptedGroq(['garbled nonsense', 'more nonsense']);
    const res = await blindReview(reviewOpts(groq, { maxAttempts: 2 }));
    expect(res.pick).toBe('B'); // incumbent label passed in
    expect(res.biggestGap).toBe('unparseable verdict; incumbent kept');
    expect(res.keptIncumbent).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('retries once on garbled output, then uses the good verdict', async () => {
    const groq = scriptedGroq([
      'oops',
      '{"pick": "B", "biggestGap": "A is blank", "notes": "clear"}',
    ]);
    const res = await blindReview(reviewOpts(groq, { maxAttempts: 3 }));
    expect(res.pick).toBe('B');
    expect(res.keptIncumbent).toBe(false);
    expect(res.attempts).toBe(2);
  });

  it('never tells the reviewer which label is incumbent (structural blindness)', async () => {
    const groq = scriptedGroq([
      '{"pick": "A", "biggestGap": "x", "notes": "y"}',
    ]);
    const spy = groq.chatCompletions as ReturnType<typeof vi.fn>;
    await blindReview(reviewOpts(groq));
    const sent = spy.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    const allText = sent.messages.map((m) => String(m.content)).join('\n');
    // No message may associate a label (A/B) with incumbency. Generic
    // blindness instructions ("you don't know which is live") are fine —
    // what matters is the payload never says WHICH candidate it is.
    expect(allText).not.toMatch(/[AB] is (the )?(incumbent|current|live)/i);
    expect(allText).not.toMatch(/(incumbent|current|live)( build| candidate)? is [AB]/i);
    expect(allText).not.toMatch(/keep [AB]/i);
    // Both candidates are present and unlabeled beyond A/B.
    expect(allText).toContain('CANDIDATE A');
    expect(allText).toContain('CANDIDATE B');
  });

  it('buildReviewMessages carries criteria and both evidence summaries', () => {
    const msgs = buildReviewMessages(
      candidate('A', { notes: 'shiny' }),
      candidate('B'),
      ['Boots clean'],
    );
    const text = msgs.map((m) => String(m.content)).join('\n');
    expect(text).toContain('Boots clean');
    expect(text).toContain('shiny');
    // The candidate-bearing user message never mentions incumbency at all.
    expect(String(msgs[1].content)).not.toMatch(/incumbent/i);
  });

  it('budget exhaustion propagates typed (never swallowed by review)', async () => {
    const groq = scriptedGroq(['{"pick": "A", "biggestGap": "x", "notes": "y"}']);
    const budgets = new BudgetTracker({ maxTokens: 1 });
    const err = await blindReview({
      ...reviewOpts(groq),
      budgets,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhaustedError);
  });
});
