import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import type { DbClient } from '../src/db.js';
import type { QueueClient } from '../src/queue.js';
import type { GitRunner } from '../src/git.js';
import type { ServerDeps } from '../src/types.js';

/* ------------------------------------------------------------------ */
/* Stubs (mirrors test/api.test.ts conventions)                        */
/* ------------------------------------------------------------------ */

type Handler = (
  text: string,
  params: unknown[],
) => { rows: Record<string, unknown>[]; rowCount: number };

function createStubDb() {
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

function createStubQueues(): QueueClient {
  return {
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
}

const stubGit: GitRunner = {
  async initRepo() {},
  async cloneRepo() {},
};

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const STORAGE = '/tmp/gf-api-test-storage';
const REPO = join(STORAGE, 'projects', PROJECT_ID, 'repo');

const PROJECT_ROW = {
  id: PROJECT_ID,
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

/** A real git repo on disk so file routes exercise real git. */
function initTestRepo() {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', REPO]);
  execFileSync('git', ['-C', REPO, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', REPO, 'config', 'user.email', 'test@local']);
  mkdirSync(join(REPO, 'src'), { recursive: true });
  writeFileSync(join(REPO, 'index.html'), '<html>game</html>');
  writeFileSync(join(REPO, 'src', 'main.js'), 'console.log("hi");\n');
  writeFileSync(join(REPO, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  mkdirSync(join(REPO, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(REPO, 'node_modules', 'dep', 'x.js'), 'excluded');
  execFileSync('git', ['-C', REPO, 'add', '.']);
  execFileSync('git', ['-C', REPO, 'commit', '-m', 'init']);
}

let server: FastifyInstance | null = null;

async function makeServer(db: ReturnType<typeof createStubDb>) {
  const deps: ServerDeps = {
    db: db as unknown as DbClient,
    queues: createStubQueues(),
    git: stubGit,
    storageRoot: STORAGE,
    version: '0.1.0-test',
    modelProviders: null,
  };
  server = await buildServer(deps);
  return server;
}

function projectHandlers(db: ReturnType<typeof createStubDb>) {
  db.on(/FROM projects WHERE id = \$1 AND deleted_at IS NULL/, () => ({
    rows: [{ ...PROJECT_ROW }],
    rowCount: 1,
  }));
}

afterEach(async () => {
  await server?.close();
  server = null;
});

function multipartBody(boundary: string, filename: string, content: Buffer) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, content, tail]);
}

/* ------------------------------------------------------------------ */
/* Project files                                                       */
/* ------------------------------------------------------------------ */

describe('project files', () => {
  beforeEach(() => {
    initTestRepo();
  });

  it('lists files recursively, excluding .git and node_modules', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/files` });
    expect(res.statusCode).toBe(200);
    const paths = res.json().files.map((f: { path: string }) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('src/main.js');
    expect(paths).toContain('blob.bin');
    expect(paths.some((p: string) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p: string) => p.startsWith('.git'))).toBe(false);
    expect([...paths].sort()).toEqual(paths);
  });

  it('reads a file with its git blob sha', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/files/src/main.js` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toContain('console.log');
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('blocks path traversal with 404 (never 500, never leaks)', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ID}/files/..%2F..%2Fsecret`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects binary files with 400 binary_file', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/files/blob.bin` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('binary_file');
  });

  it('writes a file, commits with the studio message, and returns shas', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const read = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/files/index.html` });
    const { sha } = read.json();
    const res = await s.inject({
      method: 'PUT',
      url: `/api/v1/projects/${PROJECT_ID}/files/index.html`,
      payload: { content: '<html>updated</html>', expectedSha: sha },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.sha).not.toBe(sha);
    const log = execFileSync('git', ['-C', REPO, 'log', '-1', '--format=%s']).toString().trim();
    expect(log).toBe('studio: update index.html');
    expect(readFileSync(join(REPO, 'index.html'), 'utf8')).toBe('<html>updated</html>');
  });

  it('returns 409 with currentSha on stale expectedSha and leaves the file untouched', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'PUT',
      url: `/api/v1/projects/${PROJECT_ID}/files/index.html`,
      payload: { content: '<html>stale</html>', expectedSha: '0'.repeat(40) },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('conflict');
    expect(body.error.detail.currentSha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(REPO, 'index.html'), 'utf8')).toBe('<html>game</html>');
  });

  it('creates parent directories for new nested files', async () => {
    const db = createStubDb();
    projectHandlers(db);
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'PUT',
      url: `/api/v1/projects/${PROJECT_ID}/files/deep/nested/new.txt`,
      payload: { content: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(REPO, 'deep', 'nested', 'new.txt'), 'utf8')).toBe('hello');
  });
});

/* ------------------------------------------------------------------ */
/* Revisions                                                           */
/* ------------------------------------------------------------------ */

describe('project revisions', () => {
  it('lists revisions newest-first', async () => {
    const db = createStubDb();
    projectHandlers(db);
    db.on(/FROM project_revisions WHERE project_id/, () => ({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          git_sha: 'b'.repeat(40),
          message: 'second',
          author_kind: 'agent:gameplay',
          checkpoint_kind: 'agent_edit',
          healthy: true,
          created_at: '2026-10-09T01:00:00.000Z',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          git_sha: 'a'.repeat(40),
          message: 'first',
          author_kind: 'system',
          checkpoint_kind: null,
          healthy: false,
          created_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      rowCount: 2,
    }));
    db.on(/COUNT\(\*\).*FROM project_revisions/, () => ({ rows: [{ total: '2' }], rowCount: 1 }));
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/revisions` });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items[0].sha).toBe('b'.repeat(40));
    expect(items[0].author).toBe('agent:gameplay');
  });
});

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

describe('assets', () => {
  beforeEach(() => {
    rmSync(join(STORAGE, 'assets'), { recursive: true, force: true });
  });

  function assetDb() {
    const db = createStubDb();
    projectHandlers(db);
    const store: Record<string, unknown>[] = [];
    db.on(/INSERT INTO assets/, (_t, params) => {
      const row = {
        id: params[0],
        project_id: params[1],
        path: params[2],
        kind: params[3],
        format: params[4],
        bytes: params[5],
        content_hash: params[6],
        source: 'upload',
        use_stage: 'unconfirmed',
        created_at: '2026-10-09T00:00:00.000Z',
      };
      store.push(row);
      return { rows: [row], rowCount: 1 };
    });
    db.on(/UPDATE assets SET properties/, () => ({ rows: [], rowCount: 1 }));
    db.on(/FROM assets WHERE id = \$1 AND deleted_at IS NULL/, (_t, params) => {
      const row = store.find((r) => r.id === params[0] && !(r as { deleted?: boolean }).deleted);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    });
    db.on(/FROM assets WHERE project_id = \$1 AND deleted_at IS NULL/, () => ({
      rows: store.filter((r) => !(r as { deleted?: boolean }).deleted),
      rowCount: store.length,
    }));
    db.on(/COUNT\(\*\).*FROM assets/, () => ({
      rows: [{ total: String(store.length) }],
      rowCount: 1,
    }));
    db.on(/UPDATE assets SET deleted_at/, (_t, params) => {
      const row = store.find((r) => r.id === params[0]);
      if (row) (row as { deleted?: boolean }).deleted = true;
      return { rows: [], rowCount: 1 };
    });
    return db;
  }

  it('uploads an asset, stores the file, and lists it', async () => {
    const db = assetDb();
    const s = await makeServer(db);
    const boundary = 'testboundary123';
    const payload = multipartBody(boundary, 'sprite.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await s.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/assets?kind=image`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kind).toBe('image');
    expect(body.url).toBe(`/api/v1/assets/${body.id}/download`);
    expect(existsSync(join(STORAGE, 'assets', PROJECT_ID, `${body.id}_sprite.png`))).toBe(true);

    const list = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/assets` });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it('infers kind from extension and sanitizes hostile filenames', async () => {
    const db = assetDb();
    const s = await makeServer(db);
    const boundary = 'testboundary456';
    const payload = multipartBody(boundary, '../../evil.mp3', Buffer.from([0x01, 0x02]));
    const res = await s.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/assets`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('audio');
    // No traversal: file lands inside the project asset dir.
    expect(existsSync(join(STORAGE, 'assets', PROJECT_ID))).toBe(true);
    expect(existsSync(join(STORAGE, 'evil.mp3'))).toBe(false);
  });

  it('deletes an asset (204) and removes the file', async () => {
    const db = assetDb();
    const s = await makeServer(db);
    const boundary = 'testboundary789';
    const up = await s.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/assets`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'a.png', Buffer.from([0x01])),
    });
    const { id } = up.json();
    const del = await s.inject({ method: 'DELETE', url: `/api/v1/assets/${id}` });
    expect(del.statusCode).toBe(204);
    expect(existsSync(join(STORAGE, 'assets', PROJECT_ID, `${id}_a.png`))).toBe(false);
    const list = await s.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/assets` });
    expect(list.json().items).toHaveLength(0);
  });

  it('keeps AI generation as an honest 501', async () => {
    const db = assetDb();
    const s = await makeServer(db);
    const res = await s.inject({ method: 'POST', url: '/api/v1/assets/generations', payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('not_implemented');
  });
});

/* ------------------------------------------------------------------ */
/* Build diagnostics                                                   */
/* ------------------------------------------------------------------ */

describe('build diagnostics', () => {
  const BUILD_ID = 'build_01AAAAAAAAAAAAAAAAAAAAAAAA';

  function diagDb() {
    const db = createStubDb();
    db.on(/FROM build_jobs WHERE id = \$1/, () => ({
      rows: [
        {
          id: BUILD_ID,
          project_id: PROJECT_ID,
          run_id: null,
          revision_sha: 'a'.repeat(40),
          status: 'verified',
          verdict: {},
          started_at: null,
          ended_at: null,
          created_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    }));
    db.on(/FROM test_results WHERE build_id/, () => ({
      rows: [
        { suite: 'pipeline', name: 'validateStructure', status: 'pass', duration_ms: 12, details: {}, created_at: '2026-10-09T00:00:00.000Z' },
      ],
      rowCount: 1,
    }));
    db.on(/FROM review_results WHERE build_id/, () => ({
      rows: [
        {
          criterion: 'non-blank',
          result: 'pass',
          confidence: '0.95',
          evidence: {},
          issue: null,
          recommendation: null,
          retest_required: false,
          judge_model: 'reviewer',
          created_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    }));
    db.on(/FROM build_artifacts WHERE build_id/, () => ({
      rows: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          kind: 'screenshot',
          path: 'shot.png',
          size_bytes: '1234',
          content_hash: null,
          metadata: {},
          created_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    }));
    return db;
  }

  it('returns tests, reviews, and artifacts for a build', async () => {
    const db = diagDb();
    const s = await makeServer(db);
    const tests = await s.inject({ method: 'GET', url: `/api/v1/builds/${BUILD_ID}/tests` });
    expect(tests.statusCode).toBe(200);
    expect(tests.json()[0]).toMatchObject({ name: 'validateStructure', status: 'pass', durationMs: 12 });

    const reviews = await s.inject({ method: 'GET', url: `/api/v1/builds/${BUILD_ID}/reviews` });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json()[0]).toMatchObject({ criterion: 'non-blank', result: 'pass' });

    const artifacts = await s.inject({ method: 'GET', url: `/api/v1/builds/${BUILD_ID}/artifacts` });
    expect(artifacts.statusCode).toBe(200);
    const a = artifacts.json()[0];
    expect(a.name).toBe('shot.png');
    expect(a.url).toBe('/api/v1/artifacts/44444444-4444-4444-8444-444444444444/download');
  });

  it('404s diagnostics for an unknown build', async () => {
    const db = createStubDb(); // no build_jobs handler → empty
    const s = await makeServer(db);
    const res = await s.inject({ method: 'GET', url: '/api/v1/builds/build_missing/tests' });
    expect(res.statusCode).toBe(404);
  });

  it('blocks artifact path traversal with 404', async () => {
    const db = createStubDb();
    db.on(/FROM build_jobs WHERE id = \$1/, () => ({
      rows: [
        {
          id: BUILD_ID,
          project_id: PROJECT_ID,
          run_id: null,
          revision_sha: 'a'.repeat(40),
          status: 'verified',
          verdict: {},
          started_at: null,
          ended_at: null,
          created_at: '2026-10-09T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    }));
    db.on(/FROM build_artifacts WHERE id = \$1/, () => ({
      rows: [{ id: '55555555-5555-4555-8555-555555555555', build_id: BUILD_ID, path: '../../evil' }],
      rowCount: 1,
    }));
    const s = await makeServer(db);
    const res = await s.inject({
      method: 'GET',
      url: '/api/v1/artifacts/55555555-5555-4555-8555-555555555555/download',
    });
    expect(res.statusCode).toBe(404);
  });
});
