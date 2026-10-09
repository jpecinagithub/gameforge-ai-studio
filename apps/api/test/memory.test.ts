/**
 * Tests for memory write endpoints: POST (project/studio), PUT (versioned
 * supersede), DELETE (tombstone), validation, conflict semantics, and
 * redaction-on-insert.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { DbClient } from '../src/db.js';
import type { ServerDeps } from '../src/types.js';

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

function createStubDb(): DbClient & {
  on(re: RegExp, fn: Handler): void;
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const handlers: Array<{ re: RegExp; fn: Handler }> = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const stub = {
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
  return stub;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const MEM_ROW = {
  id: 'mem_1',
  scope: 'project',
  project_id: PROJECT_ID,
  run_id: null,
  key: 'jump-tuning',
  content: 'jump is 2.5m',
  salience: '0.9',
  version: 1,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: '2026-10-09T10:00:00.000Z',
  superseded_by: null,
};

function projectHandlers(db: ReturnType<typeof createStubDb>) {
  db.on(/FROM projects WHERE id = \$1 AND deleted_at IS NULL/, () => ({
    rows: [{ id: PROJECT_ID }],
    rowCount: 1,
  }));
}

async function makeServer(db: ReturnType<typeof createStubDb>) {
  const server: FastifyInstance = await buildServer({
    db,
    queues: {
      isAvailable: async () => true,
      addRunJob: async () => {},
      addBuildJob: async () => {},
      queueDepth: async () => 0,
      close: async () => {},
    },
    git: { initRepo: async () => {}, cloneRepo: async () => {} },
    storageRoot: '/tmp/gf-api-test-storage',
    version: '0.1.0-test',
    modelProviders: null,
  } as unknown as ServerDeps);
  return server;
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('memory writes', () => {
  it('POST /projects/:id/memories → 201 with the created memory', async () => {
    const db = createStubDb();
    projectHandlers(db);
    db.on(/INSERT INTO memories/, (_t, params) => ({
      rows: [{ ...MEM_ROW, key: params[3], content: params[4], salience: String(params[5] ?? 0.5) }],
      rowCount: 1,
    }));
    server = await makeServer(db);
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/memories`,
      payload: { key: 'jump-tuning', content: 'jump is 2.5m', salience: 0.9 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe('jump-tuning');
    expect(body.scope).toBe('project');
    expect(body.salience).toBe(0.9);
    expect(body.version).toBe(1);
  });

  it('POST /studio/memories → 201 with studio scope', async () => {
    const db = createStubDb();
    db.on(/INSERT INTO memories/, () => ({ rows: [{ ...MEM_ROW, scope: 'studio', project_id: null }], rowCount: 1 }));
    server = await makeServer(db);
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/studio/memories',
      payload: { key: 'global-note', content: 'always do X' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scope).toBe('studio');
    expect(res.json().projectId).toBeNull();
  });

  it('POST duplicate key → 409 with the key in the detail', async () => {
    const db = createStubDb();
    projectHandlers(db);
    db.on(/INSERT INTO memories/, () => {
      throw new Error('duplicate key value violates unique constraint "memories_current_key"');
    });
    server = await makeServer(db);
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/memories`,
      payload: { key: 'jump-tuning', content: 'again' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('POST invalid salience → 400', async () => {
    const db = createStubDb();
    projectHandlers(db);
    server = await makeServer(db);
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/memories`,
      payload: { key: 'k', content: 'c', salience: 2 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /memories/:id supersedes: new row version+1, old row linked', async () => {
    const db = createStubDb();
    let cteParams: unknown[] = [];
    // NOTE: the CTE text also contains "FROM memories WHERE id = $1", so the
    // CTE handler must be registered FIRST.
    db.on(/WITH ins AS/, (_t, params) => {
      cteParams = params;
      return {
        rows: [{ ...MEM_ROW, id: 'mem_2', content: params[1], salience: '0.7', version: 2 }],
        rowCount: 1,
      };
    });
    db.on(/FROM memories WHERE id = \$1/, () => ({ rows: [{ ...MEM_ROW }], rowCount: 1 }));
    server = await makeServer(db);
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/memories/mem_1',
      payload: { content: 'jump is 3m now', salience: 0.7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    expect(res.json().content).toBe('jump is 3m now');
    // CTE both inserts the new row and links the old row's superseded_by.
    expect(cteParams[0]).toBe('mem_1');
  });

  it('PUT on missing memory → 404; on already-superseded → 409', async () => {
    const db = createStubDb();
    db.on(/FROM memories WHERE id = \$1/, (_t, params) =>
      params[0] === 'gone'
        ? { rows: [], rowCount: 0 }
        : { rows: [{ ...MEM_ROW, superseded_by: 'mem_2' }], rowCount: 1 },
    );
    server = await makeServer(db);
    const r404 = await server.inject({
      method: 'PUT',
      url: '/api/v1/memories/gone',
      payload: { content: 'x' },
    });
    expect(r404.statusCode).toBe(404);
    const r409 = await server.inject({
      method: 'PUT',
      url: '/api/v1/memories/mem_1',
      payload: { content: 'x' },
    });
    expect(r409.statusCode).toBe(409);
  });

  it('DELETE tombstones: superseded_by = own id, 204', async () => {
    const db = createStubDb();
    db.on(/FROM memories WHERE id = \$1/, () => ({ rows: [{ ...MEM_ROW }], rowCount: 1 }));
    let updateText = '';
    db.on(/UPDATE memories SET superseded_by = id/, (t) => {
      updateText = t;
      return { rows: [], rowCount: 1 };
    });
    server = await makeServer(db);
    const res = await server.inject({ method: 'DELETE', url: '/api/v1/memories/mem_1' });
    expect(res.statusCode).toBe(204);
    expect(updateText).toContain('superseded_by = id');
  });

  it('DELETE on missing memory → 404', async () => {
    const db = createStubDb();
    server = await makeServer(db);
    const res = await server.inject({ method: 'DELETE', url: '/api/v1/memories/gone' });
    expect(res.statusCode).toBe(404);
  });

  it('redacts credential-shaped content before insert', async () => {
    const db = createStubDb();
    projectHandlers(db);
    let inserted: unknown = null;
    db.on(/INSERT INTO memories/, (_t, params) => {
      inserted = params[4];
      return { rows: [{ ...MEM_ROW, content: params[4] }], rowCount: 1 };
    });
    server = await makeServer(db);
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/memories`,
      payload: { key: 'k', content: '{"api_key": "supersecretvalue123"}' },
    });
    expect(res.statusCode).toBe(201);
    expect(String(inserted)).not.toContain('supersecretvalue123');
    expect(res.json().content).not.toContain('supersecretvalue123');
  });
});
