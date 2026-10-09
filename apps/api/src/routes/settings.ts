import type { FastifyInstance } from 'fastify';
import { patchSettingsSchema } from '@gameforge/shared';
import { badRequest } from '../httpErrors.js';
import { parseOr400 } from './routeUtil.js';
import { PatchSettingsBody, ErrorEnvelope } from '../openapiSchemas.js';
import '../types.js';

/** Keys that must never be written through the settings API (vault owns secrets). */
const SECRET_LIKE = /key|token|secret|password|passwd|credential|dsn/i;

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const { db } = fastify.gameforge;

  fastify.get('/settings', async () => {
    const { rows } = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM application_settings ORDER BY key`,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  fastify.patch(
    '/settings',
    {
      schema: {
        tags: ['settings'],
        summary: 'Update application settings (secret values are refused)',
        body: PatchSettingsBody,
        response: { 200: { type: 'object', additionalProperties: true }, 400: ErrorEnvelope },
      },
    },
    async (req) => {
    // Check the RAW body: zod strips unknown keys, so a secret-like key would
    // otherwise vanish silently instead of being explicitly refused.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (SECRET_LIKE.test(key)) {
        throw badRequest(
          `Refusing to store secret-like setting '${key}' via the API; secrets live in the server vault`,
        );
      }
      const value = raw[key];
      if (typeof value === 'string' && /^(sk-|-----BEGIN)/.test(value)) {
        throw badRequest(
          `Refusing to store a secret-looking value for '${key}'; secrets live in the server vault`,
        );
      }
    }
    const body = parseOr400(patchSettingsSchema, req.body) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      await db.query(
        `INSERT INTO application_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
    const { rows } = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM application_settings ORDER BY key`,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
  );
}
