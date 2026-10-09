import type { FastifyInstance } from 'fastify';
import { AgentRole } from '@gameforge/shared';
import { badRequest, dependencyUnavailable } from '../httpErrors.js';
import { safeMessage } from '../redact.js';
import '../types.js';

/**
 * Model registry routes. The registry is populated at startup / on demand from
 * Groq's /v1/models (Phase 2, model-providers package). No model names are
 * hardcoded here — selection always goes through the registry.
 */

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, modelProviders } = fastify.gameforge;

  fastify.get('/models', async () => {
    const { rows } = await db.query(
      `SELECT model_id, display_name, capabilities, active, last_seen_at
         FROM model_registry WHERE active = true ORDER BY model_id`,
    );
    return {
      items: rows.map((r) => ({
        modelId: (r as Record<string, unknown>).model_id,
        displayName: (r as Record<string, unknown>).display_name,
        capabilities: (r as Record<string, unknown>).capabilities,
        lastSeenAt: (r as Record<string, unknown>).last_seen_at,
      })),
    };
  });

  fastify.get('/models/capabilities', async () => ({
    // The capability keys the registry tracks; agent roles that bind models.
    capabilityKeys: ['context_window', 'supports_tools', 'supports_vision', 'supports_json_mode'],
    agentRoles: Object.values(AgentRole),
    provider: 'groq',
  }));

  fastify.post('/models/connection-test', async (req) => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw badRequest('GROQ_API_KEY is not configured on the server');
    }
    if (!modelProviders) {
      throw dependencyUnavailable(
        'The @gameforge/model-providers package is not installed; connection test unavailable',
      );
    }
    // Opt-in tool-calling probe. Only the exact value 'true' enables it — the
    // probe sends a real chat completion and SPENDS TOKENS, so it never runs
    // unless explicitly requested.
    const probeTools = (req.query as Record<string, unknown> | undefined)?.probeTools === 'true';
    try {
      const client = modelProviders.createGroqClient(apiKey);
      const { models } = await client.listModels();
      let toolProbe: { model: string; supported: boolean } | null = null;
      if (probeTools) {
        const model = await resolveDirectorModel(db);
        if (model && typeof client.probeToolSupport === 'function') {
          const raw = await client.probeToolSupport(model);
          const supported = typeof raw === 'boolean' ? raw : Boolean(raw?.supported);
          toolProbe = { model, supported };
        }
        // toolProbe stays null when no director model is configured or the
        // installed provider package has no probe implementation.
      }
      // Never return the key, its prefix, or any credential material.
      return { ok: true, modelCount: models.length, toolProbe };
    } catch (err) {
      throw dependencyUnavailable(`Groq connection failed: ${safeMessage((err as Error).message)}`);
    }
  });
}

/**
 * Resolve the model bound to the director role (application_settings.modelByRole).
 * Returns null when nothing is configured — the probe is then skipped (toolProbe: null).
 */
async function resolveDirectorModel(
  db: import('../db.js').DbClient,
): Promise<string | null> {
  const { rows } = await db.query<{ value: unknown }>(
    `SELECT value FROM application_settings WHERE key = 'modelByRole'`,
  );
  const raw = rows[0]?.value;
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  const director = parsed?.director;
  return typeof director === 'string' && director.length > 0 ? director : null;
}
