/**
 * Semantic visual review (§6) — AI screenshot review gated on a LIVE,
 * verified vision-capable model.
 *
 * HONESTY CONTRACT (hard rule):
 * - A review row is marked `pass`/`fail` ONLY when a live vision-capable
 *   model actually examined the screenshots in this run.
 * - In every other case (no AI provider credentials, no vision model in the registry, probe
 *   failed, model returned garbage) the review is marked `unverified` with an
 *   explicit `issue` naming the reason, and deterministic checks continue.
 * - `verifyVisionModel()` is the ONLY path that produces a verified model
 *   binding: selectModel(requiresVision) → live probeVisionSupport() → true.
 *   Curated `supports_vision` flags are hypotheses, never verification.
 */
import { z } from 'zod';
import type { ReviewResultValue } from '@gameforge/shared';
import type { CloudflareClient } from '@gameforge/model-providers';
import { ModelRegistry, probeVisionSupport } from '@gameforge/model-providers';

/** One screenshot available to the reviewer. */
export interface VisionShot {
  camera: string;
  /** Raw PNG bytes (as captured by the evidence phase). */
  png: Buffer;
}

export interface VisionCriterionInput {
  id: string;
  description: string;
}

/** A model binding proven vision-capable by a live probe in this process. */
export interface VisionModelVerification {
  modelId: string;
  verifiedAt: string; // ISO
}

export interface VisualReviewDeps {
  registry: ModelRegistry;
  client: CloudflareClient;
  /** Agent-role label used for model selection + usage accounting. */
  role?: string;
  /** Max screenshots sent to the model (cost control). Default 4. */
  maxShots?: number;
  /** Max completion tokens for the review. Default 512. */
  maxTokens?: number;
  /** Called for every LLM completion (probe + review) for §7 usage accounting. */
  onUsage?: (u: {
    modelId: string;
    role: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }) => void | Promise<void>;
}

export interface SavedReviewRow {
  criterion: string;
  result: ReviewResultValue;
  confidence?: number;
  evidence?: unknown;
  issue?: string;
  recommendation?: string;
  retestRequired?: boolean;
  judgeModel?: string;
}

export type VisualReviewOutcome =
  | {
      status: 'verified';
      modelId: string;
      verifiedAt: string;
      rows: SavedReviewRow[];
    }
  | {
      status: 'unverified';
      reason: string;
      rows: SavedReviewRow[];
    };

const DEFAULT_ROLE = 'vision';
const DEFAULT_MAX_SHOTS = 4;
const DEFAULT_MAX_TOKENS = 512;

const UNVERIFIED_CRITERION = 'semantic-visual-review';

const reviewResponseSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        result: z.enum(['pass', 'fail', 'unverified']),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1),
  issues: z
    .array(
      z.object({
        camera: z.string().min(1),
        note: z.string().max(500),
        severity: z.enum(['minor', 'major']),
      }),
    )
    .optional()
    .default([]),
});

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function unverifiedRow(reason: string): SavedReviewRow {
  return { criterion: UNVERIFIED_CRITERION, result: 'unverified', issue: reason };
}

/**
 * Verify a vision-capable model binding: capability selection (never a
 * hardcoded name) followed by a LIVE vision probe. Returns null when no
 * verified binding exists — null is not an error, it is the honest state.
 */
export async function verifyVisionModel(
  deps: VisualReviewDeps,
): Promise<VisionModelVerification | null> {
  const role = deps.role ?? DEFAULT_ROLE;
  let modelId: string;
  try {
    modelId = deps.registry.selectModel({ role, requiresVision: true });
  } catch {
    return null; // no advertised vision-capable model — unverified, not failed
  }
  const ok = await probeVisionSupport(deps.client, modelId);
  if (!ok) return null; // probe inconclusive — never label verified
  return { modelId, verifiedAt: new Date().toISOString() };
}

function buildReviewPrompt(criteria: VisionCriterionInput[]): string {
  const lines = criteria.map((c) => `- ${c.id}: ${c.description}`);
  return (
    `You are a game QA reviewer. Examine these gameplay screenshots against ` +
    `the acceptance criteria below.\n\nAcceptance criteria:\n${lines.join('\n')}\n\n` +
    `Respond with ONLY a JSON object (no markdown, no prose): ` +
    `{"criteria":[{"id":"<criterion id>","result":"pass"|"fail"|"unverified","note":"<short note>"}],` +
    `"issues":[{"camera":"<camera name>","note":"<what you see wrong>","severity":"minor"|"major"}]}\n` +
    `Use "unverified" for a criterion you cannot judge from screenshots alone. ` +
    `An empty "issues" array means the visuals look correct.`
  );
}

/**
 * Run the semantic visual review. Saves review rows through `saveReviewResult`
 * and returns the outcome. Deterministic checks (blank detection, luma
 * analysis, conformance) are NOT this function's job — they run elsewhere and
 * continue regardless of this outcome.
 */
export async function runVisualReview(
  deps: VisualReviewDeps,
  input: {
    shots: VisionShot[];
    criteria: VisionCriterionInput[];
    saveReviewResult: (row: SavedReviewRow) => Promise<void>;
  },
): Promise<VisualReviewOutcome> {
  const role = deps.role ?? DEFAULT_ROLE;

  if (input.shots.length === 0) {
    const reason = 'no screenshots captured — semantic visual review skipped';
    await input.saveReviewResult(unverifiedRow(reason));
    return { status: 'unverified', reason, rows: [unverifiedRow(reason)] };
  }

  const verified = await verifyVisionModel(deps);
  if (!verified) {
    const reason = 'semantic review not performed — no verified vision-capable model';
    const row = unverifiedRow(reason);
    await input.saveReviewResult(row);
    return { status: 'unverified', reason, rows: [row] };
  }

  const shots = input.shots.slice(0, deps.maxShots ?? DEFAULT_MAX_SHOTS);
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
  > = [{ type: 'text', text: buildReviewPrompt(input.criteria) }];
  for (const shot of shots) {
    parts.push({
      type: 'image_url',
      image_url: { url: toDataUrl(shot.png), detail: 'low' },
    });
  }

  let raw: string | null;
  try {
    const res = await deps.client.chatCompletions({
      model: verified.modelId,
      messages: [{ role: 'user', content: parts }],
      jsonMode: true,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    raw = res.content;
    if (deps.onUsage) {
      await deps.onUsage({
        modelId: verified.modelId,
        role,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        latencyMs: res.latencyMs,
      });
    }
  } catch (err) {
    const reason = `vision review request failed: ${err instanceof Error ? err.message : String(err)}`;
    const row = unverifiedRow(reason);
    await input.saveReviewResult(row);
    return { status: 'unverified', reason, rows: [row] };
  }

  const parsed = parseReviewJson(raw);
  if (!parsed) {
    const reason = 'vision model returned unparseable review — not counted as verification';
    const row = unverifiedRow(reason);
    await input.saveReviewResult(row);
    return { status: 'unverified', reason, rows: [row] };
  }

  const rows: SavedReviewRow[] = parsed.criteria.map((c) => ({
    criterion: `visual: ${c.id}`,
    result: c.result as ReviewResultValue,
    issue: c.result === 'pass' ? undefined : c.note,
    evidence: {
      shots: shots.map((s) => s.camera),
      issues: parsed.issues.filter((i) =>
        shots.some((s) => s.camera === i.camera),
      ),
    },
    retestRequired: c.result === 'fail',
    judgeModel: verified.modelId,
  }));
  for (const row of rows) {
    await input.saveReviewResult(row);
  }
  return {
    status: 'verified',
    modelId: verified.modelId,
    verifiedAt: verified.verifiedAt,
    rows,
  };
}

/** Parse the model's JSON reply; null on ANY deviation — garbage never verifies. */
function parseReviewJson(raw: string | null): z.infer<typeof reviewResponseSchema> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const res = reviewResponseSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}
