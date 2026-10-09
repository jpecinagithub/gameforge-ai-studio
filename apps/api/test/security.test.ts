/**
 * Phase 7 security tests: headers, CORS, tiered rate limits, request
 * timeouts, SSE guard, and management-endpoint actor enforcement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { TieredRateLimiter, SseGuard } from '../src/security.js';
import type { DbClient } from '../src/db.js';
import type { QueueClient } from '../src/queue.js';
import type { GitRunner } from '../src/git.js';
import type { ServerDeps } from '../src/types.js';

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

function createStubDb() {
  const handlers: Array<{ re: RegExp; fn: Handler }> = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const stub = {
    calls,
    async query<T>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      for (const h of handlers) {
        if (h.re.test(text)) {
          const r = h.fn(text, params);
          return { rows: r.rows as T[], rowCount: r.rowCount };
        }
      }
      return { rows: [] as T[], rowCount: 0 };
    },
    on(re: RegExp, fn: Handler) {
      handlers.push({ re, fn });
    },
    async ping() {
      return true;
    },
    async migrate() {},
    async close() {},
  };
  return stub;
}

const stubQueues: QueueClient = {
  async isAvailable() {
    return true;
  },
  async addRunJob() {},
  async addBuildJob() {},
  async queueDepth() {
    return 0;
  },
  async close() {},
};

const stubGit: GitRunner = {
  async initRepo() {},
  async cloneRepo() {},
};

let server: FastifyInstance | null = null;

async function makeServer(): Promise<FastifyInstance> {
  const deps: ServerDeps = {
    db: createStubDb() as unknown as DbClient,
    queues: stubQueues,
    git: stubGit,
    storageRoot: '/tmp/gf-api-security-test',
    version: '0.1.0-test',
    modelProviders: null,
  };
  server = await buildServer(deps);
  return server;
}

const ENV_KEYS = [
  'ALLOWED_ORIGINS',
  'GF_RATE_MANAGEMENT_PER_MIN',
  'GF_RATE_WRITE_PER_MIN',
  'REQUEST_TIMEOUT_MS',
  'GF_SLOW_REQUEST_MS',
];

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await server?.close();
  server = null;
});

describe('security headers', () => {
  it('sets defense-in-depth headers on API responses', async () => {
    const s = await makeServer();
    const res = await s.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('CORS', () => {
  it('rejects origins not on the allowlist (no ACAO header)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com';
    const s = await makeServer();
    const res = await s.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects the preview origin: game content never gets API CORS access', async () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com';
    const s = await makeServer();
    const res = await s.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://preview.example.com:8091' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the configured studio origin', async () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com';
    const s = await makeServer();
    const res = await s.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://studio.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://studio.example.com');
  });

  it('never reflects credentials', async () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com';
    const s = await makeServer();
    const res = await s.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: {
        origin: 'https://studio.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-credentials']).not.toBe('true');
  });
});

describe('tiered rate limits', () => {
  it('429s write endpoints past the write tier with Retry-After', async () => {
    process.env.GF_RATE_WRITE_PER_MIN = '3';
    const s = await makeServer();
    const body = { name: 'Rate Test', template: 'three-empty' };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await s.inject({ method: 'POST', url: '/api/v1/projects', payload: body });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(codes[3]).toBe(429);
    const last = await s.inject({ method: 'POST', url: '/api/v1/projects', payload: body });
    expect(last.headers['retry-after']).toBeDefined();
    expect(JSON.parse(last.body).error.code).toBe('rate_limited');
  });

  it('429s management endpoints past the stricter management tier', async () => {
    process.env.GF_RATE_MANAGEMENT_PER_MIN = '2';
    const s = await makeServer();
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      // No X-Studio-Actor → 403 from the route; the tier counter runs first.
      const res = await s.inject({ method: 'POST', url: '/api/v1/improvements', payload: {} });
      codes.push(res.statusCode);
    }
    expect(codes[0]).toBe(403);
    expect(codes[1]).toBe(403);
    expect(codes[2]).toBe(429);
  });

  it('does not rate-limit reads under the tiers', async () => {
    process.env.GF_RATE_WRITE_PER_MIN = '1';
    const s = await makeServer();
    for (let i = 0; i < 5; i++) {
      const res = await s.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('request timeout', () => {
  it('503s a hung request past REQUEST_TIMEOUT_MS', async () => {
    process.env.REQUEST_TIMEOUT_MS = '100';
    const s = await makeServer();
    s.get('/__slow', async () => {
      await new Promise(() => {});
      return {};
    });
    const res = await s.inject({ method: 'GET', url: '/__slow' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('request_timeout');
    expect(res.headers['retry-after']).toBeDefined();
  }, 10000);
});

describe('TieredRateLimiter (unit)', () => {
  it('allows max requests then reports retry-after, resets after the window', () => {
    const limiter = new TieredRateLimiter(
      { max: 2, windowMs: 60_000 },
      { max: 100, windowMs: 60_000 },
    );
    expect(limiter.check('1.2.3.4', 'management', 0)).toBe(0);
    expect(limiter.check('1.2.3.4', 'management', 1_000)).toBe(0);
    const wait = limiter.check('1.2.3.4', 'management', 2_000);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    // After the window passes, allowed again.
    expect(limiter.check('1.2.3.4', 'management', 61_001)).toBe(0);
  });

  it('tiers are independent per IP', () => {
    const limiter = new TieredRateLimiter(
      { max: 1, windowMs: 60_000 },
      { max: 100, windowMs: 60_000 },
    );
    expect(limiter.check('1.2.3.4', 'management', 0)).toBe(0);
    expect(limiter.check('1.2.3.4', 'management', 1)).toBeGreaterThan(0);
    expect(limiter.check('9.9.9.9', 'management', 1)).toBe(0);
  });
});

describe('SseGuard (unit)', () => {
  it('caps concurrent streams per run and globally', () => {
    const guard = new SseGuard(2, 3);
    expect(guard.acquire('run-a')).toBe('ok');
    expect(guard.acquire('run-a')).toBe('ok');
    expect(guard.acquire('run-a')).toBe('run_limit');
    expect(guard.acquire('run-b')).toBe('ok');
    expect(guard.acquire('run-c')).toBe('global_limit');
  });

  it('release frees the slot', () => {
    const guard = new SseGuard(1, 1);
    expect(guard.acquire('run-a')).toBe('ok');
    expect(guard.acquire('run-b')).toBe('global_limit');
    guard.release('run-a');
    expect(guard.acquire('run-b')).toBe('ok');
    guard.release('run-b');
    expect(guard.snapshot().total).toBe(0);
  });
});

describe('management endpoint actor enforcement', () => {
  it('rejects agent actors on plugin management', async () => {
    const s = await makeServer();
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers: { 'x-agent-role': 'director' },
      payload: { manifest: {}, actor: 'agent:director' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires X-Studio-Actor on improvement approval', async () => {
    const s = await makeServer();
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/improvements/some-id/approve',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects agent actors on improvement approval', async () => {
    const s = await makeServer();
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/improvements/some-id/approve',
      headers: { 'x-studio-actor': 'agent:reviewer' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('body limits', () => {
  it('413s payloads over the 10 MB JSON body cap', async () => {
    const s = await makeServer();
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: JSON.stringify({ name: big, template: 'three-empty' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('payload_too_large');
  }, 30000);

  it('never leaks stack traces or env on 500s', async () => {
    const s = await makeServer();
    s.get('/__boom', async () => {
      throw new Error('kaboom: GROQ_API_KEY=gsk_secret_12345');
    });
    const res = await s.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    const body = res.body;
    expect(body).not.toContain('kaboom');
    expect(body).not.toContain('gsk_secret_12345');
    expect(JSON.parse(body).error.code).toBe('internal_error');
  });
});
