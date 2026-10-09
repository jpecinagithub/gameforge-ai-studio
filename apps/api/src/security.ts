/**
 * Phase 7 security hardening — defense-in-depth controls for the API origin.
 *
 * The reverse proxy (Caddy, infra/deploy/Caddyfile) sets the edge headers; this
 * module adds the same headers at the application layer so they hold even when
 * the proxy is bypassed or misconfigured, plus tiered rate limits, request
 * timeouts, slow-request logging, and the SSE connection guard.
 *
 * All limits are env-configurable (see apps/api/README.md "Performance budgets")
 * and the in-memory state is per server instance (tests stay isolated).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiError, ApiErrorCode } from '@gameforge/shared';

/* ------------------------------------------------------------------ */
/* 1. Security headers                                                 */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // The API origin must never be framed — the studio UI talks to it via fetch.
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-resource-policy': 'same-origin',
  // The preview origin (8091) sets its own CSP for game content; the API
  // serves JSON only, so a strict fallback here is safe.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export async function securityHeaders(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });
}

/* ------------------------------------------------------------------ */
/* 2. Tiered rate limits (stricter than the global @fastify/rate-limit)*/
/* ------------------------------------------------------------------ */

type Tier = 'management' | 'write';

function tierOf(method: string, url: string): Tier | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const path = url.split('?')[0];
  if (path.startsWith('/api/v1/plugins') || path.startsWith('/api/v1/improvements')) {
    return 'management';
  }
  if (path.startsWith('/api/v1/')) return 'write';
  return null;
}

interface TierConfig {
  max: number;
  windowMs: number;
}

/** Sliding-window tiered limiter. One instance per server (registered below). */
export class TieredRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly management: TierConfig,
    private readonly write: TierConfig,
  ) {}

  private configFor(tier: Tier): TierConfig {
    return tier === 'management' ? this.management : this.write;
  }

  /**
   * Returns the number of seconds the caller must wait before retrying,
   * or 0 when the request is allowed.
   */
  check(ip: string, tier: Tier, now = Date.now()): number {
    const { max, windowMs } = this.configFor(tier);
    const key = `${ip}:${tier}`;
    const cutoff = now - windowMs;
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (stamps.length >= max) {
      this.hits.set(key, stamps);
      return Math.ceil((stamps[0] + windowMs - now) / 1000);
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    return 0;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function tieredRateLimits(fastify: FastifyInstance): Promise<void> {
  const limiter = new TieredRateLimiter(
    { max: envInt('GF_RATE_MANAGEMENT_PER_MIN', 20), windowMs: 60_000 },
    { max: envInt('GF_RATE_WRITE_PER_MIN', 60), windowMs: 60_000 },
  );
  fastify.addHook('onRequest', async (req, reply) => {
    const tier = tierOf(req.method, req.url);
    if (!tier) return;
    const retryAfter = limiter.check(req.ip, tier);
    if (retryAfter > 0) {
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send(
          apiError(
            ApiErrorCode.RATE_LIMITED,
            'Rate limit exceeded for this endpoint tier',
            String(req.id),
          ),
        );
    }
  });
}

/* ------------------------------------------------------------------ */
/* 3. Request timeout + slow-request logging                            */
/* ------------------------------------------------------------------ */

const SSE_PATH = /^\/api\/v1\/runs\/[^/]+\/events(\?|$)/;
const START_KEY = Symbol('requestStart');

export async function requestTimeouts(fastify: FastifyInstance): Promise<void> {
  const timeoutMs = envInt('REQUEST_TIMEOUT_MS', 30_000);
  const slowMs = envInt('GF_SLOW_REQUEST_MS', 1000);

  fastify.addHook('onRequest', async (req, reply) => {
    (req as unknown as Record<symbol, number>)[START_KEY] = Date.now();
    // SSE streams are long-lived by design — the stream itself is bounded by
    // the SseGuard caps and terminates when the run reaches a terminal state.
    if (SSE_PATH.test(req.url)) return;
    const timer = setTimeout(() => {
      if (!reply.sent && !reply.raw.destroyed) {
        req.log.warn({ url: req.url, timeoutMs }, 'request timed out');
        void reply
          .code(503)
          .header('retry-after', '5')
          .send(apiError(ApiErrorCode.REQUEST_TIMEOUT, 'Request timed out', String(req.id)));
      }
    }, timeoutMs);
    // Do not keep the process alive for a dangling timer.
    timer.unref?.();
    reply.raw.on('close', () => clearTimeout(timer));
  });

  fastify.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as Record<symbol, number | undefined>)[START_KEY];
    if (typeof start !== 'number') return;
    const durationMs = Date.now() - start;
    if (durationMs >= slowMs) {
      req.log.warn(
        { method: req.method, url: req.url, durationMs, statusCode: reply.statusCode },
        'slow request',
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* 4. SSE connection guard                                              */
/* ------------------------------------------------------------------ */

/**
 * Bounds concurrent SSE streams: per-run and global caps. Acquire before
 * hijacking the response; release on close. 429s (not 500s) when full.
 */
export class SseGuard {
  private readonly perRun = new Map<string, number>();
  private total = 0;
  constructor(
    readonly maxPerRun = 8,
    readonly maxTotal = 64,
  ) {}

  acquire(runId: string): 'ok' | 'run_limit' | 'global_limit' {
    if (this.total >= this.maxTotal) return 'global_limit';
    const n = this.perRun.get(runId) ?? 0;
    if (n >= this.maxPerRun) return 'run_limit';
    this.perRun.set(runId, n + 1);
    this.total += 1;
    return 'ok';
  }

  release(runId: string): void {
    const n = this.perRun.get(runId) ?? 0;
    if (n <= 1) this.perRun.delete(runId);
    else this.perRun.set(runId, n - 1);
    this.total = Math.max(0, this.total - 1);
  }

  snapshot(): { perRun: Record<string, number>; total: number } {
    return { perRun: Object.fromEntries(this.perRun), total: this.total };
  }
}

export function createSseGuard(): SseGuard {
  return new SseGuard(envInt('GF_SSE_MAX_PER_RUN', 8), envInt('GF_SSE_MAX_TOTAL', 64));
}

export const SSE_REPLAY_LIMIT = (): number => envInt('GF_SSE_REPLAY_LIMIT', 500);

export async function registerSecurity(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('sseGuard', createSseGuard());
  // Call directly (not via fastify.register): hooks must attach to the ROOT
  // instance so they cover every route. fastify.register() would encapsulate
  // them in an empty child context where no routes live.
  await securityHeaders(fastify);
  await tieredRateLimits(fastify);
  await requestTimeouts(fastify);
}
