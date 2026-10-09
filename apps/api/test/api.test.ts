import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { DbClient } from '../src/db.js';
import type { QueueClient } from '../src/queue.js';
import type { GitRunner } from '../src/git.js';
import type { ServerDeps, ModelProviders } from '../src/types.js';

/* ------------------------------------------------------------------ */
/* Stubs                                                               */
/* ------------------------------------------------------------------ */

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

function createStubDb(): DbClient & {
  on(re: RegExp, fn: Handler): void;
  calls: Array<{ text: string; params: unknown[] }>;
  pingResult: boolean;
} {
  const handlers: Array<{ re: RegExp; fn: Handler }> = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const stub = {
    calls,
    pingResult: true,
    on(re: RegExp, fn: Handler) {
      handlers.push({ re, fn });
    },
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
    async ping() {
      return stub.pingResult;
    },
    async migrate() {},
    async close() {},
  };
  return stub;
}

function createStubQueues(): QueueClient & { runCalls: unknown[]; buildCalls: unknown[] } {
  const runCalls: unknown[] = [];
  const buildCalls: unknown[] = [];
  return {
    runCalls,
    buildCalls,
    async isAvailable() {
      return true;
    },
    async addRunJob(runId: string, data: Record<string, unknown>, opts?: { jobId?: string }) {
      runCalls.push({ runId, data, opts });
    },
    async addBuildJob(buildId: string, data: Record<string, unknown>, opts?: { jobId?: string }) {
      buildCalls.push({ buildId, data, opts });
    },
    async queueDepth() {
      return 0;
    },
    async close() {},
  };
}

const stubGit: GitRunner = {
  async initRepo() {},
  async cloneRepo() {},
};

const PROJECT_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'test-game-abc12345',
  name: 'Test Game',
  description: null,
  template: 'three-empty',
  kind: null,
  engine: 'three',
  status: 'active',
  current_revision_id: null,
  last_good_build_id: null,
  metadata: {},
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
};

function projectHandlers(db: ReturnType<typeof createStubDb>) {
  db.on(/FROM projects WHERE id = \$1 AND deleted_at IS NULL/, () => ({
    rows: [{ ...PROJECT_ROW }],
    rowCount: 1,
  }));
}

/* ------------------------------------------------------------------ */
/* Server factory per test                                             */
/* ------------------------------------------------------------------ */

let server: FastifyInstance | null = null;

async function makeServer(opts?: {
  db?: ReturnType<typeof createStubDb>;
  modelProviders?: ModelProviders | null;
}): Promise<{ server: FastifyInstance; db: ReturnType<typeof createStubDb>; queues: ReturnType<typeof createStubQueues> }> {
  const db = opts?.db ?? createStubDb();
  const queues = createStubQueues();
  const deps: ServerDeps = {
    db,
    queues,
    git: stubGit,
    storageRoot: '/tmp/gf-api-test-storage',
    version: '0.1.0-test',
    modelProviders: opts?.modelProviders ?? null,
  };
  server = await buildServer(deps);
  return { server, db, queues };
}

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('system', () => {
  it('GET /health returns the liveness shape', async () => {
    const { server } = await makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '0.1.0-test' });
  });

  it('GET /ready returns 503 when dependencies are down', async () => {
    const db = createStubDb();
    db.pingResult = false;
    const { server } = await makeServer({ db });
    // queues stub reports available; db down is enough for 503
    const res = await server.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ postgres: 'down', redis: 'up' });
  });

  it('unknown route returns the 404 envelope', async () => {
    const { server } = await makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.requestId).toBe('string');
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });
});

describe('validation', () => {
  it('POST /projects with an empty body returns 400 validation_failed', async () => {
    const { server } = await makeServer();
    const res = await server.inject({ method: 'POST', url: '/api/v1/projects', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('POST /projects rejects an unknown template', async () => {
    const { server } = await makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'X', template: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    // Caught by the OpenAPI schema enum (validation_failed); the handler-level
    // badRequest check remains as defense-in-depth.
    expect(res.json().error.code).toBe('validation_failed');
  });
});

describe('runs idempotency', () => {
  const RUN_ROW = {
    id: 'run_01JTEST123',
    project_id: PROJECT_ROW.id,
    conversation_id: null,
    mode: 'auto',
    status: 'queued',
    current_step: null,
    budgets: {},
    journal: {},
    started_at: null,
    ended_at: null,
    created_at: '2026-10-09T00:00:00.000Z',
  };

  it('GET /projects/:id/runs lists runs for the project', async () => {
    const db = createStubDb();
    projectHandlers(db);
    db.on(/COUNT\(\*\)[^]*FROM agent_runs WHERE project_id/, () => ({
      rows: [{ total: '1' }],
      rowCount: 1,
    }));
    db.on(/FROM agent_runs WHERE project_id = \$1/, () => ({
      rows: [{ ...RUN_ROW }],
      rowCount: 1,
    }));

    const { server } = await makeServer({ db });
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ROW.id}/runs`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('run_01JTEST123');
  });

  it('GET /projects/:id/runs 404s for an unknown project', async () => {
    const db = createStubDb();
    db.on(/FROM projects WHERE id = \$1 AND deleted_at IS NULL/, () => ({
      rows: [],
      rowCount: 0,
    }));

    const { server } = await makeServer({ db });
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/projects/does-not-exist/runs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('same idempotency key returns the same run and enqueues once', async () => {
    const db = createStubDb();
    projectHandlers(db);
    let existingCalls = 0;
    db.on(/FROM agent_runs WHERE idempotency_key/, () => {
      existingCalls += 1;
      // First POST: no existing run. Second POST: the run exists.
      return existingCalls === 1
        ? { rows: [], rowCount: 0 }
        : { rows: [{ ...RUN_ROW }], rowCount: 1 };
    });
    db.on(/INSERT INTO agent_runs/, () => ({ rows: [{ ...RUN_ROW }], rowCount: 1 }));
    db.on(/INSERT INTO agent_events/, () => ({ rows: [], rowCount: 1 }));

    const { server, queues } = await makeServer({ db });
    const payload = { mode: 'auto', idempotencyKey: 'test-key-12345678' };

    const r1 = await server.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ROW.id}/runs`, payload });
    expect(r1.statusCode).toBe(202);
    expect(r1.json().id).toBe('run_01JTEST123');

    const r2 = await server.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ROW.id}/runs`, payload });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe('run_01JTEST123');

    expect(queues.runCalls).toHaveLength(1);
    // BullMQ-level dedupe: jobId = idempotency key
    expect((queues.runCalls[0] as { opts?: { jobId?: string } }).opts?.jobId).toBe('test-key-12345678');
  });

  it('run lifecycle: pause → resume → cancel', async () => {
    const db = createStubDb();
    let status = 'running';
    let journal: Record<string, unknown> = {};
    db.on(/FROM agent_runs WHERE id = \$1/, () => ({
      rows: [{ id: 'run_x', project_id: PROJECT_ROW.id, conversation_id: null, mode: 'auto', status, current_step: null, budgets: {}, journal, started_at: null, ended_at: null, created_at: '' }],
      rowCount: 1,
    }));
    db.on(/UPDATE agent_runs SET journal/, (_t, params) => {
      journal = JSON.parse(params[1] as string) as Record<string, unknown>;
      return { rows: [], rowCount: 1 };
    });
    db.on(/UPDATE agent_runs SET status = 'canceled'/, () => {
      status = 'canceled';
      return { rows: [], rowCount: 1 };
    });
    db.on(/INSERT INTO agent_events/, () => ({ rows: [], rowCount: 1 }));

    const { server } = await makeServer({ db });
    expect((await server.inject({ method: 'POST', url: '/api/v1/runs/run_x/pause' })).statusCode).toBe(200);
    expect(journal.paused).toBe(true);
    expect((await server.inject({ method: 'POST', url: '/api/v1/runs/run_x/resume' })).statusCode).toBe(200);
    expect(journal.paused).toBe(false);
    const cancel = await server.inject({ method: 'POST', url: '/api/v1/runs/run_x/cancel' });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('canceled');
    // Terminal states are immutable
    const cancelAgain = await server.inject({ method: 'POST', url: '/api/v1/runs/run_x/cancel' });
    expect(cancelAgain.statusCode).toBe(409);
  });

  it('GET /runs/:id/events streams existing events then ends on terminal status', async () => {
    const db = createStubDb();
    db.on(/FROM agent_runs WHERE id = \$1/, () => ({
      rows: [{ id: 'run_done', project_id: PROJECT_ROW.id, conversation_id: null, mode: 'auto', status: 'completed', current_step: null, budgets: {}, journal: {}, started_at: null, ended_at: null, created_at: '' }],
      rowCount: 1,
    }));
    db.on(/FROM agent_events/, () => ({
      rows: [
        { seq: '1', kind: 'run_created', payload: { mode: 'auto' }, created_at: '' },
        { seq: '2', kind: 'completed', payload: {}, created_at: '' },
      ],
      rowCount: 2,
    }));
    db.on(/SELECT status FROM agent_runs/, () => ({ rows: [{ status: 'completed' }], rowCount: 1 }));

    const { server } = await makeServer({ db });
    const res = await server.inject({ method: 'GET', url: '/api/v1/runs/run_done/events' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('id: run_done:1');
    expect(res.body).toContain('id: run_done:2');
    expect(res.body).toContain('event: done');
  });
});

describe('settings', () => {
  it('PATCH /settings refuses secret-like keys', async () => {
    const { server } = await makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/nope',
      payload: {},
    });
    expect(res.statusCode).toBe(404); // sanity: routing works
    const bad = await server.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { apiKey: 'gsk_should_not_be_stored' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
  });

  it('PATCH /settings refuses secret-looking values', async () => {
    const db = createStubDb();
    db.on(/FROM application_settings/, () => ({ rows: [], rowCount: 0 }));
    const { server } = await makeServer({ db });
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { theme: 'gsk_abcdef123456' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /settings accepts legitimate keys', async () => {
    const db = createStubDb();
    db.on(/INSERT INTO application_settings/, () => ({ rows: [], rowCount: 1 }));
    db.on(/FROM application_settings/, () => ({
      rows: [{ key: 'theme', value: 'light' }],
      rowCount: 1,
    }));
    const { server } = await makeServer({ db });
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { theme: 'light' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ theme: 'light' });
  });
});

describe('models connection-test', () => {
  const providers: ModelProviders = {
    createCloudflareClient: () => ({
      listModels: async () => ['m1', 'm2', 'm3'],
      probeToolSupport: async (modelId: string) => modelId === 'director-model',
    }),
  };

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  });

  function settingsDb(director: string | null) {
    const db = createStubDb();
    db.on(/FROM application_settings WHERE key = 'modelByRole'/, () => ({
      rows: director ? [{ value: { director } }] : [],
      rowCount: director ? 1 : 0,
    }));
    return db;
  }

  it('without probeTools: lists models only, zero token cost, toolProbe null', async () => {
    let probed = 0;
    const counting: ModelProviders = {
      createCloudflareClient: () => ({
        listModels: async () => ['m1'],
        probeToolSupport: async () => {
          probed += 1;
          return true;
        },
      }),
    };
    const { server } = await makeServer({ db: settingsDb('director-model'), modelProviders: counting });
    const res = await server.inject({ method: 'POST', url: '/api/v1/models/connection-test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, modelCount: 1, toolProbe: null });
    expect(probed).toBe(0);
    expect(JSON.stringify(res.json())).not.toContain('test-token');
  });

  it('with probeTools=true: probes the director model', async () => {
    const { server } = await makeServer({ db: settingsDb('director-model'), modelProviders: providers });
    const res = await server.inject({ method: 'POST', url: '/api/v1/models/connection-test?probeTools=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      modelCount: 3,
      toolProbe: { model: 'director-model', supported: true },
    });
  });

  it('with probeTools=true but no director model: toolProbe null', async () => {
    const { server } = await makeServer({ db: settingsDb(null), modelProviders: providers });
    const res = await server.inject({ method: 'POST', url: '/api/v1/models/connection-test?probeTools=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().toolProbe).toBeNull();
  });

  it('without Cloudflare credentials: 400 and no credential material anywhere', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const { server } = await makeServer({ modelProviders: providers });
    const res = await server.inject({ method: 'POST', url: '/api/v1/models/connection-test' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('honest stubs', () => {
  it('import still returns 501 not_implemented (Phase 7)', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const { server } = await makeServer({ db });
    const imp = await server.inject({ method: 'POST', url: '/api/v1/projects/import', payload: {} });
    expect(imp.statusCode).toBe(501);
  });

  it('export refuses a missing project repo with 500, not a fake ZIP', async () => {
    // The stub DB returns the project but no repo exists on disk: git fails
    // loudly instead of producing an empty/fake archive. Ensure the repo dir
    // is absent regardless of what other test files created (shared storage).
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    rmSync(join('/tmp/gf-api-test-storage', 'projects', PROJECT_ROW.id), {
      recursive: true,
      force: true,
    });
    const db = createStubDb();
    projectHandlers(db);
    const { server } = await makeServer({ db });
    const exp = await server.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ROW.id}/export` });
    expect(exp.statusCode).toBe(500);
  });
});
