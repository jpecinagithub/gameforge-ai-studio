/**
 * Live Groq model capability registry (master prompt §2, ARCHITECTURE.md §7).
 *
 * - `refresh(client)` probes `GET /v1/models` at startup / on demand and upserts
 *   entries. Models that disappear are marked active=false — never deleted, so
 *   historical model_usage rows keep their meaning.
 * - Capability data comes from a DATE-STAMPED curated table. This table is DATA,
 *   not selection logic: `selectModel()` never names a model, it filters on
 *   capabilities. The table must be re-verified against Groq docs periodically.
 * - Models absent from the curated table get CONSERVATIVE defaults
 *   (no tools, no vision) unless a best-effort probe verifies otherwise.
 *   Probing costs tokens and is opt-in only — refresh() never probes.
 */
import { modelCapabilitiesSchema } from '@gameforge/shared';
import type { GroqClient } from './groq.js';
import { ModelUnavailableError } from './errors.js';

export interface ModelCapabilities {
  context_window: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_json_mode: boolean;
  max_output_tokens?: number;
}

export interface RegistryEntry {
  modelId: string;
  capabilities: ModelCapabilities;
  discoveredAt: string; // ISO
  lastSeenAt: string; // ISO
  active: boolean;
}

/**
 * Curated capability data. DATE-STAMPED: curated 2026-10-09 from Groq docs and
 * a live /v1/models probe. MUST be re-verified — Groq retires and renames
 * models (e.g. llama-3.3-70b-versatile was retired 2026-08-16 per AGENT JOB ops
 * notes). Treat every row as a hypothesis until refresh() confirms the model
 * still exists; capability flags remain curated estimates.
 */
export const CURATED_CAPABILITIES_AS_OF = '2026-10-09';

const CURATED: Record<string, ModelCapabilities> = {
  'openai/gpt-oss-120b': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_json_mode: true,
  },
  'openai/gpt-oss-20b': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_json_mode: true,
  },
  'llama-3.3-70b-versatile': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_json_mode: true,
  },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: true,
    supports_json_mode: true,
  },
  'meta-llama/llama-4-maverick-17b-128e-instruct': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: true,
    supports_json_mode: true,
  },
  'qwen/qwen3-32b': {
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_json_mode: true,
  },
};

// Fail fast if the curated data ever violates the shared schema.
for (const [modelId, caps] of Object.entries(CURATED)) {
  const parsed = modelCapabilitiesSchema.safeParse(caps);
  if (!parsed.success) {
    throw new Error(
      `Curated capabilities for "${modelId}" are invalid: ${parsed.error.message}`,
    );
  }
}

/** Conservative defaults for unlisted models: claim nothing we cannot verify. */
export const CONSERVATIVE_DEFAULTS: ModelCapabilities = {
  context_window: 8192,
  supports_tools: false,
  supports_vision: false,
  supports_json_mode: false,
};

export interface SelectModelOptions {
  role: string;
  requiresTools?: boolean;
  requiresVision?: boolean;
  requiresJsonMode?: boolean;
  /** Prefer larger-context models (planning/reasoning); otherwise prefer small. */
  preferLarge?: boolean;
}

export interface RefreshReport {
  seen: string[];
  added: string[];
  reactivated: string[];
  deactivated: string[];
}

export class ModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /** Refresh from Groq's live model list. Never probes (probing costs tokens). */
  async refresh(client: GroqClient): Promise<RefreshReport> {
    const now = new Date().toISOString();
    const live = await client.listModels();
    const seen = new Set(live);
    const report: RefreshReport = { seen: live, added: [], reactivated: [], deactivated: [] };

    for (const modelId of live) {
      const existing = this.entries.get(modelId);
      if (existing) {
        existing.lastSeenAt = now;
        if (!existing.active) {
          existing.active = true;
          report.reactivated.push(modelId);
        }
      } else {
        this.entries.set(modelId, {
          modelId,
          capabilities: CURATED[modelId] ?? { ...CONSERVATIVE_DEFAULTS },
          discoveredAt: now,
          lastSeenAt: now,
          active: true,
        });
        report.added.push(modelId);
      }
    }
    for (const [modelId, entry] of this.entries) {
      if (entry.active && !seen.has(modelId)) {
        entry.active = false; // never delete — history keeps its meaning
        report.deactivated.push(modelId);
      }
    }
    return report;
  }

  getCapabilities(modelId: string): ModelCapabilities | undefined {
    return this.entries.get(modelId)?.capabilities;
  }

  isActive(modelId: string): boolean {
    return this.entries.get(modelId)?.active ?? false;
  }

  listActive(): RegistryEntry[] {
    return [...this.entries.values()].filter((e) => e.active);
  }

  /**
   * Select a model purely by capability — no model names appear in this logic.
   * Throws ModelUnavailableError naming the missing capability when nothing fits.
   */
  selectModel(opts: SelectModelOptions): string {
    const active = this.listActive();

    const require = (
      flag: keyof ModelCapabilities,
      capabilityName: string,
      needed: boolean | undefined,
    ): RegistryEntry[] => {
      if (!needed) return active;
      const fitting = active.filter((e) => e.capabilities[flag] === true);
      if (fitting.length === 0) {
        throw new ModelUnavailableError(
          capabilityName,
          `Role "${opts.role}" requires ${capabilityName}, but none of the ` +
            `${active.length} active Groq model(s) advertise it. ` +
            `Refresh the registry or configure a compatible model.`,
        );
      }
      return fitting;
    };

    let candidates = active;
    if (candidates.length === 0) {
      throw new ModelUnavailableError(
        'any-model',
        `Role "${opts.role}" needs a model but the registry is empty. ` +
          `Call refresh() against Groq first.`,
      );
    }
    // Intersect capability filters; each names its own missing capability.
    for (const flag of ['supports_tools', 'supports_vision', 'supports_json_mode'] as const) {
      const needed =
        flag === 'supports_tools'
          ? opts.requiresTools
          : flag === 'supports_vision'
            ? opts.requiresVision
            : opts.requiresJsonMode;
      const names = {
        supports_tools: 'tool-calling',
        supports_vision: 'vision',
        supports_json_mode: 'JSON mode',
      } as const;
      candidates = require(flag, names[flag], needed).filter((e) => candidates.includes(e));
    }

    const sorted = [...candidates].sort((a, b) => {
      const byWindow = opts.preferLarge
        ? b.capabilities.context_window - a.capabilities.context_window
        : a.capabilities.context_window - b.capabilities.context_window;
      if (byWindow !== 0) return byWindow;
      return a.modelId < b.modelId ? -1 : 1; // deterministic tiebreak
    });
    const winner = sorted[0];
    if (!winner) {
      // Unreachable given the guards above, but fail closed rather than undefined.
      throw new ModelUnavailableError(
        'any-model',
        `Role "${opts.role}": capability intersection left no candidates.`,
      );
    }
    return winner.modelId;
  }
}

/**
 * Best-effort vision-support probe: sends a 1x1 PNG and asks for one word back.
 * COSTS TOKENS — opt-in only, never called by refresh(). A `true` result is
 * evidence that the model accepted and described an image; a `false`/error
 * result is inconclusive (the model may have declined or errored), never
 * proof of absence. Only a `true` result may label a review "verified".
 */
export async function probeVisionSupport(
  client: GroqClient,
  modelId: string,
  opts?: { maxTokens?: number },
): Promise<boolean> {
  try {
    const res = await client.chatCompletions({
      model: modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with the single word OK.' },
            { type: 'image_url', image_url: { url: ONE_PX_PNG_DATA_URL, detail: 'low' } },
          ],
        },
      ],
      maxTokens: opts?.maxTokens ?? 8,
    });
    return typeof res.content === 'string' && res.content.trim().length > 0;
  } catch {
    return false; // inconclusive, never proof
  }
}

/** 1x1 opaque PNG data URL — minimal probe payload. */
const ONE_PX_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Best-effort tool-support probe: asks the model to make a trivial tool call.
 * COSTS TOKENS — opt-in only, never called by refresh(). A `true` result is
 * evidence; a `false`/error result is inconclusive (the model may just have
 * declined), never proof of absence.
 */
export async function probeToolSupport(
  client: GroqClient,
  modelId: string,
): Promise<boolean> {
  try {
    const res = await client.chatCompletions({
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with a single tool call.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'probe_ping',
            description: 'Capability probe; takes no arguments.',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'probe_ping' } },
      maxTokens: 16,
    });
    return res.toolCalls.some((c) => c.name === 'probe_ping');
  } catch {
    return false; // inconclusive, never proof
  }
}
