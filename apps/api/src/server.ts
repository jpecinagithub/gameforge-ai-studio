import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ulid } from 'ulid';
import { apiError, globalRedactor } from '@gameforge/shared';
import { HttpError } from './httpErrors.js';
import type { ServerDeps } from './types.js';
import './types.js';
import { registerOpenApi } from './openapi.js';
import { registerSecurity } from './security.js';
import { systemRoutes } from './routes/system.js';
import { projectRoutes } from './routes/projects.js';
import { projectFileRoutes } from './routes/projectFiles.js';
import { conversationRoutes } from './routes/conversations.js';
import { runRoutes } from './routes/runs.js';
import { buildRoutes } from './routes/builds.js';
import { assetRoutes } from './routes/assets.js';
import { modelRoutes } from './routes/models.js';
import { pluginRoutes } from './routes/plugins.js';
import { improvementRoutes } from './routes/improvements.js';
import { settingsRoutes } from './routes/settings.js';
import { memoryRoutes } from './routes/memory.js';

/**
 * Build the Fastify application. All external dependencies (db, queues, git)
 * are injected via `deps` so tests can substitute stubs — no live Postgres,
 * Redis or git required for the route-level suite.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (isProd && allowedOrigins.includes('*')) {
    throw new Error("Refusing to start: ALLOWED_ORIGINS must not be '*' in production");
  }

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Pino-level redaction for known secret locations. Structured payloads
      // must additionally pass through globalRedactor at the call site —
      // pino cannot deep-scan arbitrary objects.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.body.apiKey',
          'req.body.api_key',
          'req.body.token',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 10 * 1024 * 1024, // 10 MB
    genReqId: () => `req_${ulid()}`,
  });

  fastify.decorate('gameforge', deps);

  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await fastify.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: false,
  });

  await fastify.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 100),
    timeWindow: '1 minute',
  });

  // Multipart for asset uploads (Phase 5). 10 MiB per file; the route enforces
  // its own cap too and streams to disk rather than buffering everything.
  await fastify.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
  });

  // Phase 7: defense-in-depth security controls (headers, tiered rate limits,
  // request timeouts, slow-request logging, SSE connection guard).
  await registerSecurity(fastify);

  fastify.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id ?? 'unknown');
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) req.log.error({ err, code: err.code }, 'http error');
      const detail = err.detail ? globalRedactor.redactDeep(err.detail) : undefined;
      return reply
        .code(err.statusCode)
        .send(apiError(err.code, globalRedactor.redactText(err.message), requestId, detail));
    }
    // Fastify's own schema validator (AJV) runs before route handlers for routes
    // that declare JSON schemas: normalize its failures to the same envelope.
    const validation = (err as { validation?: Array<{ instancePath?: string; message?: string; keyword?: string }> }).validation;
    if (Array.isArray(validation)) {
      const detail = globalRedactor.redactDeep({
        issues: validation.map((v) => ({
          path: v.instancePath ?? '',
          message: v.message ?? v.keyword ?? 'invalid',
        })),
      }) as Record<string, unknown>;
      return reply.code(400).send(apiError('validation_failed', 'Request validation failed', requestId, detail));
    }
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (statusCode === 413) {
      return reply.code(413).send(apiError('payload_too_large', 'Request body too large', requestId));
    }
    if (statusCode === 429) {
      return reply.code(429).send(apiError('rate_limited', 'Rate limit exceeded', requestId));
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(apiError('bad_request', 'Bad request', requestId));
    }
    // 500s: never leak stack traces or secrets to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(apiError('internal_error', 'Internal server error', requestId));
  });

  fastify.setNotFoundHandler((req, reply) =>
    reply.code(404).send(apiError('not_found', `No route ${req.method} ${req.url}`, String(req.id))),
  );

  await registerOpenApi(fastify);

  const prefix = '/api/v1';
  await fastify.register(systemRoutes, { prefix });
  await fastify.register(projectRoutes, { prefix });
  await fastify.register(projectFileRoutes, { prefix });
  await fastify.register(conversationRoutes, { prefix });
  await fastify.register(runRoutes, { prefix });
  await fastify.register(buildRoutes, { prefix });
  await fastify.register(assetRoutes, { prefix });
  await fastify.register(modelRoutes, { prefix });
  await fastify.register(pluginRoutes, { prefix });
  await fastify.register(settingsRoutes, { prefix });
  await fastify.register(memoryRoutes, { prefix });
  await fastify.register(improvementRoutes, { prefix });

  return fastify;
}
