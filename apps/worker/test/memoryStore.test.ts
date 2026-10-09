/**
 * Tests for the pg MemoryStore: SQL shapes, upsert-supersede write semantics,
 * tombstone exclusion, and record mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPgMemoryStore } from '../src/memoryStore.js';
import type { DbPool } from '../src/db.js';

interface Call {
  text: string;
  params: unknown[] | undefined;
}

function mockPool(handler: (text: string, params: unknown[]) => { rows: unknown[] }): {
  pool: DbPool;
  calls: Call[];
} {
  const calls: Call[] = [];
  const pool: DbPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { ...handler(text, params ?? []), rowCount: 1 };
    }),
    connect: vi.fn(async () => {
      throw new Error('not used');
    }),
    end: vi.fn(async () => {}),
  };
  return { pool, calls };
}

const ROW = {
  id: 'mem_1',
  scope: 'project',
  project_id: 'proj_1',
  run_id: null,
  key: 'jump-tuning',
  content: 'jump is 2.5m',
  salience: '0.90',
  version: 2,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: '2026-10-09T11:00:00.000Z',
};

describe('createPgMemoryStore', () => {
  it('write upserts: single statement, supersedes old row, version+1', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [ROW] }));
    const store = createPgMemoryStore(pool);
    const rec = await store.write({
      scope: 'project',
      projectId: 'proj_1',
      key: 'jump-tuning',
      content: 'jump is 2.5m',
      salience: 0.9,
    });
    expect(calls).toHaveLength(1);
    const sql = calls[0]!.text;
    // One statement does insert-new + supersede-old (CTE).
    expect(sql).toMatch(/WITH ins AS/i);
    expect(sql).toMatch(/UPDATE memories m SET superseded_by = ins.id/i);
    expect(sql).toMatch(/version \+ 1/i);
    expect(calls[0]!.params).toEqual(['project', 'proj_1', null, 'jump-tuning', 'jump is 2.5m', 0.9]);
    expect(rec.id).toBe('mem_1');
    expect(rec.salience).toBe(0.9);
    expect(rec.version).toBe(2);
    expect(rec.projectId).toBe('proj_1');
    expect(rec.updatedAt).toBe('2026-10-09T11:00:00.000Z');
  });

  it('write throws a typed error when nothing is inserted', async () => {
    const { pool } = mockPool(() => ({ rows: [] }));
    const store = createPgMemoryStore(pool);
    await expect(
      store.write({ scope: 'run', runId: 'r1', key: 'k', content: 'c' }),
    ).rejects.toThrow(/no row/);
  });

  it('listCurrent filters to non-superseded rows for the scope/project', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [ROW] }));
    const store = createPgMemoryStore(pool);
    const out = await store.listCurrent('project', 'proj_1');
    expect(out).toHaveLength(1);
    const sql = calls[0]!.text;
    expect(sql).toMatch(/superseded_by IS NULL/);
    expect(sql).toMatch(/ORDER BY salience DESC, updated_at DESC/);
    expect(calls[0]!.params![0]).toBe('project');
  });

  it('search prefilters by keyword terms and caps limit', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const store = createPgMemoryStore(pool);
    await store.search('project', 'proj_1', 'player jump height!', 5);
    const sql = calls[0]!.text;
    expect(sql).toMatch(/ILIKE/);
    expect(sql).toMatch(/superseded_by IS NULL/);
    // terms: player, jump, height → 3 LIKE params + limit 5
    const params = calls[0]!.params!;
    expect(params.slice(2, 5)).toEqual(['%player%', '%jump%', '%height%']);
    expect(params[params.length - 1]).toBe(5);
  });

  it('search with no significant tokens omits the keyword filter', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const store = createPgMemoryStore(pool);
    await store.search('studio', null, 'a b!', 8);
    expect(calls[0]!.text).not.toMatch(/ILIKE/);
  });

  it('supersede throws when the row is missing or already superseded', async () => {
    const { pool } = mockPool(() => ({ rows: [] }));
    const store = createPgMemoryStore(pool);
    await expect(store.supersede('nope', 'new')).rejects.toThrow(/missing or already superseded/);
  });
});
