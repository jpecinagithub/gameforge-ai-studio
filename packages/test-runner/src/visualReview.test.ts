/**
 * visualReview tests — the honesty contract is the point:
 * - 'verified' ONLY when a live vision model actually reviewed the shots.
 * - every other path → 'unverified' with an explicit reason.
 * No test touches a real Groq endpoint.
 */
import { describe, expect, it, vi } from 'vitest';
import { ModelUnavailableError } from '@gameforge/model-providers';
import {
  runVisualReview,
  verifyVisionModel,
  type SavedReviewRow,
  type VisualReviewDeps,
} from './visualReview.js';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function visionCapableRegistry(modelId = 'test/vision-model') {
  return { selectModel: () => modelId } as unknown as VisualReviewDeps['registry'];
}

function noVisionRegistry() {
  return {
    selectModel: () => {
      throw new ModelUnavailableError('vision', 'no vision model');
    },
  } as unknown as VisualReviewDeps['registry'];
}

/** Fake Groq client: probe answers OK (or per `probeBehavior`), review answers `reviewReply`. */
function fakeClient(opts: {
  probeBehavior?: 'ok' | 'empty' | 'throws';
  reviewReply?: string | null;
  onCall?: (kind: 'probe' | 'review') => void;
}) {
  return {
    chatCompletions: async (call: { jsonMode?: boolean; maxTokens?: number }) => {
      const kind = call.jsonMode ? 'review' : 'probe';
      opts.onCall?.(kind);
      if (kind === 'probe') {
        if (opts.probeBehavior === 'throws') throw new Error('network down');
        const content = opts.probeBehavior === 'empty' ? '   ' : 'OK';
        return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 }, model: 'm', latencyMs: 5 };
      }
      return {
        content: opts.reviewReply ?? null,
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'm',
        latencyMs: 42,
      };
    },
  } as unknown as VisualReviewDeps['client'];
}

function baseDeps(registry: VisualReviewDeps['registry'], client: VisualReviewDeps['client']): VisualReviewDeps {
  return { registry, client, onUsage: vi.fn() };
}

const shots = [{ camera: 'main', png: ONE_PX_PNG }];
const criteria = [{ id: 'looks-right', description: 'The game renders its world' }];

const GOOD_REPLY = JSON.stringify({
  criteria: [{ id: 'looks-right', result: 'pass', note: 'world visible' }],
  issues: [],
});

describe('verifyVisionModel', () => {
  it('returns a verified binding when selection + live probe succeed', async () => {
    const deps = baseDeps(visionCapableRegistry(), fakeClient({}));
    const v = await verifyVisionModel(deps);
    expect(v).not.toBeNull();
    expect(v?.modelId).toBe('test/vision-model');
  });

  it('null when no vision-capable model is advertised', async () => {
    const v = await verifyVisionModel(baseDeps(noVisionRegistry(), fakeClient({})));
    expect(v).toBeNull();
  });

  it('null when the live probe fails (inconclusive is never verification)', async () => {
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ probeBehavior: 'empty' }));
    expect(await verifyVisionModel(deps)).toBeNull();
  });

  it('null when the probe throws', async () => {
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ probeBehavior: 'throws' }));
    expect(await verifyVisionModel(deps)).toBeNull();
  });
});

describe('runVisualReview', () => {
  it('verified: live vision model reviews shots, rows carry judge_model', async () => {
    const rows: SavedReviewRow[] = [];
    const calls: string[] = [];
    const deps = baseDeps(
      visionCapableRegistry(),
      fakeClient({ reviewReply: GOOD_REPLY, onCall: (k) => calls.push(k) }),
    );
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('verified');
    if (out.status === 'verified') expect(out.modelId).toBe('test/vision-model');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      criterion: 'visual: looks-right',
      result: 'pass',
      judgeModel: 'test/vision-model',
    });
    // probe ran before review (capability gate, not a hardcoded claim)
    expect(calls).toEqual(['probe', 'review']);
    expect(deps.onUsage).toHaveBeenCalledTimes(1);
  });

  it('verified can fail criteria honestly (vision said so)', async () => {
    const rows: SavedReviewRow[] = [];
    const reply = JSON.stringify({
      criteria: [{ id: 'looks-right', result: 'fail', note: 'blank screen' }],
      issues: [{ camera: 'main', note: 'nothing rendered', severity: 'major' }],
    });
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ reviewReply: reply }));
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('verified');
    expect(rows[0].result).toBe('fail');
    expect(rows[0].issue).toBe('blank screen');
    expect(rows[0].retestRequired).toBe(true);
  });

  it('unverified when no vision-capable model, with the explicit reason', async () => {
    const rows: SavedReviewRow[] = [];
    const deps = baseDeps(noVisionRegistry(), fakeClient({}));
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
    if (out.status === 'unverified') {
      expect(out.reason).toBe('semantic review not performed — no verified vision-capable model');
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      criterion: 'semantic-visual-review',
      result: 'unverified',
    });
    expect(rows[0].issue).toContain('no verified vision-capable model');
    expect(rows[0].judgeModel).toBeUndefined();
  });

  it('unverified when the live probe is inconclusive', async () => {
    const rows: SavedReviewRow[] = [];
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ probeBehavior: 'empty' }));
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
    expect(rows[0].result).toBe('unverified');
  });

  it('unverified when the model returns unparseable JSON (garbage never verifies)', async () => {
    const rows: SavedReviewRow[] = [];
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ reviewReply: '{not json' }));
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
    expect(rows[0].issue).toContain('unparseable');
  });

  it('unverified when the model returns schema-violating JSON', async () => {
    const rows: SavedReviewRow[] = [];
    const deps = baseDeps(
      visionCapableRegistry(),
      fakeClient({ reviewReply: JSON.stringify({ criteria: [{ id: 'x', result: 'maybe' }] }) }),
    );
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
  });

  it('unverified when there are no screenshots', async () => {
    const rows: SavedReviewRow[] = [];
    const deps = baseDeps(visionCapableRegistry(), fakeClient({ reviewReply: GOOD_REPLY }));
    const out = await runVisualReview(deps, {
      shots: [],
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
    if (out.status === 'unverified') expect(out.reason).toContain('no screenshots');
  });

  it('unverified when the review request itself fails', async () => {
    const rows: SavedReviewRow[] = [];
    const client = {
      chatCompletions: async (call: { jsonMode?: boolean }) => {
        if (!call.jsonMode) {
          return { content: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 };
        }
        throw new Error('429 rate limited');
      },
    } as unknown as VisualReviewDeps['client'];
    const deps = baseDeps(visionCapableRegistry(), client);
    const out = await runVisualReview(deps, {
      shots,
      criteria,
      saveReviewResult: async (r) => {
        rows.push(r);
      },
    });
    expect(out.status).toBe('unverified');
    expect(rows[0].issue).toContain('failed');
  });

  it('sends at most maxShots screenshots', async () => {
    const seenImageCounts: number[] = [];
    const client = {
      chatCompletions: async (call: { jsonMode?: boolean; messages?: Array<{ content?: unknown[] }> }) => {
        if (!call.jsonMode) {
          return { content: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 };
        }
        const parts = call.messages?.[0]?.content ?? [];
        seenImageCounts.push(parts.filter((p) => (p as { type: string }).type === 'image_url').length);
        return {
          content: GOOD_REPLY,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'm',
          latencyMs: 1,
        };
      },
    } as unknown as VisualReviewDeps['client'];
    const deps = { ...baseDeps(visionCapableRegistry(), client), maxShots: 2 };
    const manyShots = [0, 1, 2, 3, 4].map((i) => ({ camera: `cam${i}`, png: ONE_PX_PNG }));
    await runVisualReview(deps, {
      shots: manyShots,
      criteria,
      saveReviewResult: async () => {},
    });
    expect(seenImageCounts).toEqual([2]);
  });
});
