import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { DbClient } from '../src/db.js';
import type { QueueClient } from '../src/queue.js';
import type { GitRunner } from '../src/git.js';
import type { ServerDeps } from '../src/types.js';

/* Stub DB with an in-memory improvement_proposals table. */

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

const KNOWN_BUILD = 'build_known_1';
const KNOWN_REVIEW = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createStubDb() {
  const handlers: Array<{ re: RegExp; fn: Handler }> = [];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const proposals = new Map<string, Record<string, unknown>>();
  const skillVersions: Array<Record<string, unknown>> = [];
  const settings = new Map<string, unknown>();

  const stub = {
    calls,
    proposals,
    skillVersions,
    settings,
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
  } as unknown as DbClient & {
    on(re: RegExp, fn: Handler): void;
    calls: Array<{ text: string; params: unknown[] }>;
    proposals: Map<string, Record<string, unknown>>;
    skillVersions: Array<Record<string, unknown>>;
    settings: Map<string, unknown>;
  };

  const row = () => ({ rows: [{}], rowCount: 1 });

  stub.on(/SELECT 1 FROM build_jobs/, (_t, p) =>
    p[0] === KNOWN_BUILD ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 },
  );
  stub.on(/SELECT 1 FROM review_results/, (_t, p) =>
    p[0] === KNOWN_REVIEW ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 },
  );
  stub.on(/INSERT INTO improvement_proposals\b/, (_t, p) => {
    const rec: Record<string, unknown> = {
      id: PROPOSAL_ID,
      version: 1,
      title: p[0],
      scope: p[1],
      target: p[2],
      change: JSON.parse(p[3] as string),
      evidence: JSON.parse(p[4] as string),
      status: 'proposed',
      proposed_by: p[5],
      approved_by: null,
      approved_at: null,
      applied_at: null,
      previous_state: null,
      outcome: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    proposals.set(PROPOSAL_ID, rec);
    return { rows: [rec], rowCount: 1 };
  });
  stub.on(/INSERT INTO improvement_proposal_versions/, () => row());
  stub.on(/INSERT INTO audit_events/, () => row());
  stub.on(/SELECT \* FROM improvement_proposals WHERE id/, (_t, p) => {
    const rec = proposals.get(p[0] as string);
    return rec ? { rows: [rec], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  stub.on(/SELECT \* FROM improvement_proposals ORDER BY/, () => ({
    rows: [...proposals.values()],
    rowCount: proposals.size,
  }));
  stub.on(/SELECT COUNT\(\*\)/, () => ({
    rows: [{ total: String(proposals.size) }],
    rowCount: 1,
  }));
  stub.on(/SELECT version, change, evidence, created_by, created_at/, () => ({ rows: [], rowCount: 0 }));

  stub.on(/UPDATE improvement_proposals/, (text, p) => {
    const rec = proposals.get(p[0] as string);
    if (!rec) return { rows: [], rowCount: 0 };
    if (text.includes("status = 'approved'")) {
      rec.status = 'approved';
      rec.approved_by = p[1];
      rec.approved_at = new Date().toISOString();
    } else if (text.includes("status = 'rejected'")) {
      rec.status = 'rejected';
    } else if (text.includes("status = 'applied'")) {
      rec.status = 'applied';
      rec.applied_at = new Date().toISOString();
      rec.previous_state = JSON.parse(p[1] as string);
      rec.outcome = JSON.parse(p[2] as string);
    } else if (text.includes("status = 'rolled_back'")) {
      rec.status = 'rolled_back';
      rec.outcome = JSON.parse(p[1] as string);
    } else if (text.includes('SET outcome = $2')) {
      rec.outcome = JSON.parse(p[1] as string);
    }
    rec.updated_at = new Date().toISOString();
    return { rows: [rec], rowCount: 1 };
  });

  stub.on(/SELECT COALESCE\(MAX\(version\)/, () => ({ rows: [{ v: 1 }], rowCount: 1 }));
  stub.on(/SELECT version FROM skill_versions/, () => ({ rows: [], rowCount: 0 }));
  stub.on(/INSERT INTO skill_versions/, (_t, p) => {
    skillVersions.push({ skill_name: p[0], version: p[1], status: 'candidate' });
    return row();
  });
  stub.on(/UPDATE skill_versions/, () => row());

  stub.on(/SELECT value FROM application_settings/, (_t, p) => {
    const v = settings.get(p[0] as string);
    return v === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value: v }], rowCount: 1 };
  });
  stub.on(/INSERT INTO application_settings/, (_t, p) => {
    settings.set(p[0] as string, JSON.parse(p[1] as string));
    return row();
  });
  stub.on(/UPDATE application_settings/, (_t, p) => {
    settings.set(p[0] as string, JSON.parse(p[1] as string));
    return row();
  });
  stub.on(/DELETE FROM application_settings/, (_t, p) => {
    settings.delete(p[0] as string);
    return row();
  });

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

let db: ReturnType<typeof createStubDb>;
let app: FastifyInstance;

const USER = { 'x-studio-actor': 'user:jon' };
const AGENT = { 'x-studio-actor': 'agent:gameplay' };

async function propose(scope: string, target: string, change: Record<string, unknown>, headers = USER) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/improvements',
    headers,
    payload: {
      title: `Improve ${target}`,
      scope,
      target,
      change,
      evidence: [{ kind: 'build', id: KNOWN_BUILD }],
    },
  });
}

beforeEach(async () => {
  db = createStubDb();
  const deps = {
    db: db as unknown as DbClient,
    queues: createStubQueues(),
    git: stubGit,
    storageRoot: '/tmp/gf-test',
    modelProviders: undefined,
    groqApiKey: undefined,
  } as unknown as ServerDeps;
  app = await buildServer(deps);
});

describe('POST /improvements (propose)', () => {
  it('403 without an actor header', async () => {
    const res = await propose('config', 'theme', { value: 'dark' }, {});
    expect(res.statusCode).toBe(403);
  });

  it('proposes with valid build evidence → proposed', async () => {
    const res = await propose('config', 'theme', { value: 'dark' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('proposed');
    expect(body.scope).toBe('config');
    expect(body.id).toBe(PROPOSAL_ID);
  });

  it('400 when evidence references an unknown build', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/improvements',
      headers: USER,
      payload: {
        title: 'x',
        scope: 'config',
        target: 'theme',
        change: { value: 'dark' },
        evidence: [{ kind: 'build', id: 'build_nope' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unknown build');
  });

  it('400 on secret-like config target', async () => {
    const res = await propose('config', 'groq_api_key', { value: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('400 on path-traversal code target', async () => {
    const res = await propose('code', '../../evil.ts', { diff: '--- a' });
    expect(res.statusCode).toBe(400);
  });

  it('agents may propose (only approval is human-only)', async () => {
    const res = await propose('config', 'theme', { value: 'dark' }, AGENT);
    expect(res.statusCode).toBe(200);
    expect(res.json().proposedBy).toBe('agent:gameplay');
  });
});

describe('approve / apply trust rules', () => {
  it('agents can NEVER approve → 403', async () => {
    await propose('config', 'theme', { value: 'dark' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/approve`,
      headers: AGENT,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('agents cannot approve');
  });

  it('apply without prior approval → 409 (auto-apply is OFF)', async () => {
    await propose('config', 'theme', { value: 'dark' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: USER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('approval is required');
  });

  it('agents can NEVER apply → 403', async () => {
    await propose('config', 'theme', { value: 'dark' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/approve`,
      headers: USER,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: AGENT,
    });
    expect(res.statusCode).toBe(403);
  });

  it('approve → apply → applied for config scope, writes settings', async () => {
    await propose('config', 'previewQuality', { value: 'high' });
    let res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/approve`,
      headers: USER,
    });
    expect(res.json().status).toBe('approved');
    expect(res.json().approvedBy).toBe('user:jon');

    res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: USER,
    });
    expect(res.json().status).toBe('applied');
    expect(db.settings.get('previewQuality')).toBe('high');

    // Double-apply is rejected.
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: USER,
    });
    expect(res.statusCode).toBe(409);
  });

  it('prompt scope stages a candidate (never activates)', async () => {
    await propose('prompt', 'director', { content: 'Be nicer.' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/approve`,
      headers: USER,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: USER,
    });
    const body = res.json();
    expect(body.status).toBe('applied');
    expect(body.outcome.staged).toBe('candidate');
    expect(db.skillVersions.some((v) => v.status === 'candidate')).toBe(true);
    expect(db.skillVersions.some((v) => v.status === 'active')).toBe(false);
  });

  it('code scope stores the diff for manual review, never executes', async () => {
    await propose('code', 'docs/notes.md', { diff: '--- a/docs/notes.md\n+++ b/docs/notes.md' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/approve`,
      headers: USER,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/apply`,
      headers: USER,
    });
    expect(res.json().outcome.staged).toBe('manual-review');
  });

  it('activate promotes the staged candidate with gate evidence', async () => {
    await propose('prompt', 'director', { content: 'Be nicer.' });
    for (const action of ['approve', 'apply']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/improvements/${PROPOSAL_ID}/${action}`,
        headers: USER,
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/activate`,
      headers: USER,
      payload: { gateEvidence: [{ kind: 'review', id: KNOWN_REVIEW }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome.activated).toBe(true);
  });

  it('activate with unknown gate evidence → 400', async () => {
    await propose('prompt', 'director', { content: 'Be nicer.' });
    for (const action of ['approve', 'apply']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/improvements/${PROPOSAL_ID}/${action}`,
        headers: USER,
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/activate`,
      headers: USER,
      payload: { gateEvidence: [{ kind: 'review', id: '33333333-3333-4333-8333-333333333333' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('rollback', () => {
  it('config rollback restores the previous value', async () => {
    db.settings.set('previewQuality', 'low');
    await propose('config', 'previewQuality', { value: 'high' });
    for (const action of ['approve', 'apply']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/improvements/${PROPOSAL_ID}/${action}`,
        headers: USER,
      });
    }
    expect(db.settings.get('previewQuality')).toBe('high');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/rollback`,
      headers: USER,
    });
    expect(res.json().status).toBe('rolled_back');
    expect(db.settings.get('previewQuality')).toBe('low');
  });

  it('config rollback removes a key that did not exist before', async () => {
    await propose('config', 'brandNewKey', { value: 1 });
    for (const action of ['approve', 'apply']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/improvements/${PROPOSAL_ID}/${action}`,
        headers: USER,
      });
    }
    await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/rollback`,
      headers: USER,
    });
    expect(db.settings.has('brandNewKey')).toBe(false);
  });

  it('rollback of a non-applied proposal → 409', async () => {
    await propose('config', 'theme', { value: 'dark' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/improvements/${PROPOSAL_ID}/rollback`,
      headers: USER,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('read endpoints', () => {
  it('GET /improvements lists newest-first; GET /improvements/:id shows versions', async () => {
    await propose('config', 'theme', { value: 'dark' });
    const list = await app.inject({ method: 'GET', url: '/api/v1/improvements', headers: USER });
    expect(list.json().items).toHaveLength(1);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/improvements/${PROPOSAL_ID}`,
      headers: USER,
    });
    expect(detail.json().id).toBe(PROPOSAL_ID);
    expect(Array.isArray(detail.json().versions)).toBe(true);
  });

  it('GET /improvements/:id unknown → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/improvements/99999999-9999-4999-8999-999999999999',
      headers: USER,
    });
    expect(res.statusCode).toBe(404);
  });
});
