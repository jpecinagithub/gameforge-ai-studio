import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { DbClient } from '../src/db.js';
import type { QueueClient } from '../src/queue.js';
import type { GitRunner } from '../src/git.js';
import type { ServerDeps } from '../src/types.js';

/* Reuse the stub-db pattern from api.test.ts (regex-matched handlers). */

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

function createStubDb() {
  const handlers: Array<{ re: RegExp; fn: Handler }> = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    calls,
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
      return true;
    },
    async migrate() {},
    async close() {},
  };
}

const stubQueues: QueueClient = {
  async isAvailable() {
    return true;
  },
  async addRunJob() {},
  async addBuildJob() {},
} as unknown as QueueClient;

const stubGit: GitRunner = {
  async initRepo() {},
  async cloneRepo() {},
};

const MANIFEST = {
  apiVersion: 'gameforge-plugin/v1',
  id: 'procedural-geometry',
  name: 'Procedural Geometry',
  version: '1.0.0',
  publisher: 'gameforge',
  description: 'Deterministic procedural mesh generation',
  capabilities: ['tools'],
  tools: [
    { name: 'generate', description: 'make a mesh', roles: ['asset'], timeoutMs: 5000 },
  ],
  panels: [],
};

function pluginRow(state = 'not-enabled') {
  return {
    id: 'procedural-geometry',
    version: '1.0.0',
    publisher: 'gameforge',
    name: 'Procedural Geometry',
    description: 'Deterministic procedural mesh generation',
    capabilities: ['tools'],
    install_state: state,
    origin: 'local',
  };
}

let server: FastifyInstance | null = null;
let storageRoot = '';

async function makeServer(db: ReturnType<typeof createStubDb>) {
  storageRoot = await mkdtemp(join(tmpdir(), 'gf-plugins-'));
  const deps: ServerDeps = {
    db: db as unknown as DbClient,
    queues: stubQueues,
    git: stubGit,
    storageRoot,
    version: '0.1.0-test',
    modelProviders: null,
  };
  server = await buildServer(deps);
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(storageRoot, { recursive: true, force: true });
});

describe('plugin management routes', () => {
  it('installs a valid manifest → 201, persists row + manifest file', async () => {
    const db = createStubDb();
    db.on(/INSERT INTO plugins/, () => ({ rows: [pluginRow()], rowCount: 1 }));
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { manifest: MANIFEST },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('procedural-geometry');
    expect(body.installState).toBe('not-enabled');
    expect(body.manifestSha).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = JSON.parse(
      await readFile(join(storageRoot, 'plugins', 'procedural-geometry', 'plugin.json'), 'utf8'),
    );
    expect(onDisk.id).toBe('procedural-geometry');
  });

  it('rejects an invalid manifest → 400', async () => {
    const db = createStubDb();
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { manifest: { ...MANIFEST, id: 'BAD ID!' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(db.calls.length).toBe(0); // nothing persisted
  });

  it('enables and disables a plugin', async () => {
    const db = createStubDb();
    db.on(/UPDATE plugins/, (_t, params) => ({
      rows: [pluginRow(params[1] as string)],
      rowCount: 1,
    }));
    const s = await makeServer(db);
    const en = await s.inject({ method: 'POST', url: '/api/v1/plugins/procedural-geometry/enable' });
    expect(en.statusCode).toBe(200);
    expect(en.json().installState).toBe('enabled');
    const dis = await s.inject({ method: 'POST', url: '/api/v1/plugins/procedural-geometry/disable' });
    expect(dis.json().installState).toBe('disabled');
  });

  it('enable of an unknown plugin → 404', async () => {
    const db = createStubDb();
    const s = await makeServer(db);
    const res = await s.inject({ method: 'POST', url: '/api/v1/plugins/nope/enable' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /plugins lists registry rows', async () => {
    const db = createStubDb();
    db.on(/FROM plugins/, () => ({ rows: [pluginRow('enabled')], rowCount: 1 }));
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: '/api/v1/plugins' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].installState).toBe('enabled');
  });

  it('agent-identified requests are rejected with 403 (trust model)', async () => {
    const db = createStubDb();
    db.on(/INSERT INTO plugins/, () => ({ rows: [pluginRow()], rowCount: 1 }));
    db.on(/UPDATE plugins/, () => ({ rows: [pluginRow('enabled')], rowCount: 1 }));
    const s = await makeServer(db);

    // Via x-agent-role header…
    const h1 = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers: { 'x-agent-role': 'director' },
      payload: { manifest: MANIFEST },
    });
    expect(h1.statusCode).toBe(403);
    expect(h1.json().error.code).toBe('forbidden');

    // …and via an agent actor in the body.
    const h2 = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/procedural-geometry/enable',
      payload: { actor: 'agent:director' },
    });
    expect(h2.statusCode).toBe(403);

    // …and on disable too.
    const h3 = await s.inject({
      method: 'POST',
      url: '/api/v1/plugins/procedural-geometry/disable',
      headers: { 'x-agent-role': 'asset' },
    });
    expect(h3.statusCode).toBe(403);
  });
});
