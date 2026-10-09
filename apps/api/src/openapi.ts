import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerOpenApi(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'GameForge AI Studio API',
        version: 'v1',
        description:
          'Control API for the GameForge AI Studio single-user game development ' +
          'environment. All routes are versioned under /api/v1. Errors use a typed envelope.',
      },
      servers: [{ url: '/api/v1' }],
      tags: [
        { name: 'system', description: 'Health, readiness, capabilities, metrics' },
        { name: 'projects', description: 'Project lifecycle' },
        { name: 'conversations', description: 'Chat messages' },
        { name: 'runs', description: 'Agent run orchestration' },
        { name: 'builds', description: 'Build jobs' },
        { name: 'assets', description: 'Asset inventory (Phase 5+)' },
        { name: 'models', description: 'Groq model registry' },
        { name: 'plugins', description: 'Plugin registry (Phase 6+)' },
        { name: 'settings', description: 'Application settings' },
        { name: 'memory', description: 'Agent memory (Phase 4+)' },
      ],
    },
  });
  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
  fastify.get('/api/v1/openapi.json', async (_req, reply) => reply.send(fastify.swagger()));
}
