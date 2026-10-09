import type { FastifyInstance } from 'fastify';
import '../types.js';

/** The 8 functional starter templates (master prompt §5). */
export const TEMPLATE_IDS = [
  'three-empty',
  'three-fps',
  'three-third-person',
  'three-racing',
  'three-platformer',
  'arcade-2d',
  'puzzle',
  'physics-sandbox',
] as const;

export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, queues, version } = fastify.gameforge;
  const startedAt = Date.now();

  fastify.get('/health', async () => ({
    status: 'ok',
    version,
  }));

  fastify.get('/ready', async (_req, reply) => {
    const [postgres, redis] = await Promise.all([db.ping(), queues.isAvailable()]);
    const body = { postgres: postgres ? 'up' : 'down', redis: redis ? 'up' : 'down' };
    return reply.code(postgres && redis ? 200 : 503).send(body);
  });

  fastify.get('/system/capabilities', async () => {
    let runner: string = 'unavailable';
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('docker', ['info'], { timeout: 5000 });
      runner = 'docker';
    } catch {
      runner = 'unavailable';
    }
    return {
      engines: ['groq'],
      templates: [...TEMPLATE_IDS],
      runner,
      // Blender adapter exists only after the Oracle instance proves capable (Phase 6).
      blender: 'disabled:pending-inspection',
      // Vision review only when the live model registry confirms a vision-capable model.
      visionReview: 'requires-vision-capable-model',
    };
  });

  fastify.get('/system/metrics', async () => {
    const [agentRunsDepth, buildsDepth] = await Promise.all([
      queues.queueDepth('agent-runs'),
      queues.queueDepth('builds'),
    ]);
    return {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      queues: {
        'agent-runs': agentRunsDepth,
        builds: buildsDepth,
      },
    };
  });
}
