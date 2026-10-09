import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseManifest, checkManifestCoherence } from '@gameforge/plugin-sdk';
import { forbidden, notFound, validationFailed } from '../httpErrors.js';
import '../types.js';

/**
 * Plugin registry routes — Phase 6.
 *
 *   GET  /plugins            — list installed plugins
 *   POST /plugins/install    — validate + persist a plugin manifest
 *   POST /plugins/:id/enable — enable a plugin
 *   POST /plugins/:id/disable — disable a plugin
 *
 * TRUST MODEL (ARCHITECTURE.md §plugin-sdk): agents can NEVER install or
 * enable plugins. These endpoints reject any request that identifies as
 * agent-originated (`x-agent-role` header or an `actor: "agent:*"` body
 * field) with 403. The studio has no user accounts by design; the human
 * actor is whoever drives the UI. Worker/agent tooling MUST set
 * `x-agent-role` on any API callbacks so this guard holds.
 *
 * Manifests are stored on disk at <storageRoot>/plugins/<id>/plugin.json and
 * their sha256 lands in plugins.manifest_sha (DATABASE.md §1.15).
 */

const installBodySchema = z.object({
  manifest: z.unknown(),
  origin: z.enum(['local', 'catalog']).default('local'),
  /** Optional actor declaration; agent actors are rejected (trust model). */
  actor: z.string().max(128).optional(),
});

function rejectAgentActor(req: FastifyRequest, body: { actor?: string }): void {
  const header = req.headers['x-agent-role'];
  const headerAgent = typeof header === 'string' && header.length > 0;
  const bodyAgent = typeof body.actor === 'string' && body.actor.startsWith('agent:');
  if (headerAgent || bodyAgent) {
    throw forbidden(
      'Plugin management is never available to agents. A human must install, enable, or disable plugins.',
      { endpoint: req.url },
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

interface PluginRow {
  id: string;
  version: string;
  publisher: string;
  name: string;
  description: string;
  capabilities: unknown;
  install_state: string;
  origin: string;
}

function toPublic(r: PluginRow) {
  return {
    id: r.id,
    version: r.version,
    publisher: r.publisher,
    name: r.name,
    description: r.description,
    capabilities: r.capabilities,
    installState: r.install_state,
    origin: r.origin,
  };
}

export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, storageRoot } = fastify.gameforge;

  fastify.get('/plugins', async () => {
    const { rows } = await db.query<PluginRow>(
      `SELECT id, version, publisher, name, description, capabilities, install_state, origin
         FROM plugins ORDER BY name`,
    );
    return { items: rows.map(toPublic) };
  });

  fastify.post('/plugins/install', async (req, reply) => {
    const parsed = installBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw validationFailed({ body: 'expected { manifest, origin?, actor? }' });
    }
    rejectAgentActor(req, parsed.data);

    let manifest;
    try {
      manifest = parseManifest(parsed.data.manifest);
      checkManifestCoherence(manifest);
    } catch (err) {
      throw validationFailed({
        manifest: err instanceof Error ? err.message : 'invalid manifest',
      });
    }

    // Persist the manifest on disk; the DB row references it via manifest_sha.
    const manifestSha = createHash('sha256').update(stableJson(manifest)).digest('hex');
    const pluginDir = join(storageRoot, 'plugins', manifest.id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    const { rows } = await db.query<PluginRow>(
      `INSERT INTO plugins
         (id, version, publisher, name, description, capabilities, install_state, origin, manifest_sha, installed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'not-enabled',$7,$8, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         publisher = EXCLUDED.publisher,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         capabilities = EXCLUDED.capabilities,
         origin = EXCLUDED.origin,
         manifest_sha = EXCLUDED.manifest_sha,
         updated_at = now()
       RETURNING id, version, publisher, name, description, capabilities, install_state, origin`,
      [
        manifest.id,
        manifest.version,
        manifest.publisher,
        manifest.name,
        manifest.description,
        JSON.stringify(manifest.capabilities),
        parsed.data.origin,
        manifestSha,
      ],
    );
    const row = rows[0];
    reply.code(201);
    return { ...toPublic(row), manifestSha };
  });

  for (const action of ['enable', 'disable'] as const) {
    fastify.post(`/plugins/:id/${action}`, async (req) => {
      const body = (req.body ?? {}) as { actor?: string };
      rejectAgentActor(req, body);
      const { id } = req.params as { id: string };
      const target = action === 'enable' ? 'enabled' : 'disabled';
      const { rows } = await db.query<PluginRow>(
        `UPDATE plugins SET install_state = $2, updated_at = now()
          WHERE id = $1
          RETURNING id, version, publisher, name, description, capabilities, install_state, origin`,
        [id, target],
      );
      if (rows.length === 0) throw notFound(`Plugin "${id}"`);
      return toPublic(rows[0]);
    });
  }
}
