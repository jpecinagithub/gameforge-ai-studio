/**
 * Tests for the memory system: pure ranking, prompt formatting, and the
 * remember tool (validation + scope mapping + redaction).
 */
import { describe, it, expect } from 'vitest';
import { createSecretRedactor } from '@gameforge/shared';
import {
  rankMemories,
  relevanceRetrieve,
  formatMemoriesForPrompt,
  significantTokens,
  scoreMemory,
  rememberArgsSchema,
  executeRemember,
  type MemoryRecord,
  type MemoryStore,
} from '../src/memory.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `mem_${over.key ?? 'x'}`,
    scope: 'project',
    projectId: 'proj_1',
    runId: null,
    key: over.key ?? 'k',
    content: over.content ?? 'content',
    salience: over.salience ?? 0.5,
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function fakeStore(records: MemoryRecord[]): MemoryStore & { written: unknown[] } {
  const written: unknown[] = [];
  return {
    written,
    write: async (input) => {
      written.push(input);
      return rec({
        key: input.key,
        content: input.content,
        salience: input.salience ?? 0.5,
        scope: input.scope,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
      });
    },
    supersede: async () => {
      throw new Error('not implemented');
    },
    listCurrent: async (scope, projectId) =>
      records.filter(
        (r) =>
          r.scope === scope &&
          (scope === 'studio' || r.projectId === (projectId ?? null)),
      ),
    search: async () => [],
  };
}

describe('significantTokens', () => {
  it('lowercases, drops stopwords and short tokens', () => {
    expect(significantTokens('The Game Uses WebGL Rendering')).toEqual([
      'game',
      'uses',
      'webgl',
      'rendering',
    ]);
  });
});

describe('rankMemories', () => {
  it('salience decides when keywords and recency tie', () => {
    const a = rec({ key: 'a', salience: 0.9 });
    const b = rec({ key: 'b', salience: 0.1 });
    // Same content/recency → no keyword signal either way.
    const ranked = rankMemories([b, a], 'unrelated zebra query', { nowMs: NOW });
    expect(ranked[0]!.key).toBe('a');
    expect(ranked[1]!.key).toBe('b');
  });

  it('keyword overlap decides when salience ties', () => {
    const a = rec({ key: 'a', salience: 0.5, content: 'the player jump height is tuned' });
    const b = rec({ key: 'b', salience: 0.5, content: 'the skybox uses a gradient shader' });
    const ranked = rankMemories([b, a], 'player jump height', { nowMs: NOW });
    expect(ranked[0]!.key).toBe('a');
  });

  it('recency decides when salience and keywords tie', () => {
    const old = rec({ key: 'old', updatedAt: '2026-01-01T00:00:00Z' });
    const fresh = rec({ key: 'fresh', updatedAt: '2026-10-09T11:00:00Z' });
    const ranked = rankMemories([old, fresh], 'zzzz qqqq', { nowMs: NOW });
    expect(ranked[0]!.key).toBe('fresh');
  });

  it('respects limit and is deterministic (tie-break by updatedAt, then key)', () => {
    const rs = [rec({ key: 'c' }), rec({ key: 'a' }), rec({ key: 'b' })];
    const once = rankMemories(rs, 'zzzz', { nowMs: NOW, limit: 2 });
    const twice = rankMemories(rs, 'zzzz', { nowMs: NOW, limit: 2 });
    expect(once.map((r) => r.key)).toEqual(['a', 'b']);
    expect(twice.map((r) => r.key)).toEqual(once.map((r) => r.key));
  });

  it('scoreMemory weights: salience 0.5 / recency 0.2 / keywords 0.3', () => {
    const r = rec({
      salience: 1,
      updatedAt: new Date(NOW).toISOString(),
      content: 'alpha beta gamma',
      key: 'k',
    });
    // All three signals maxed: 0.5 + 0.2 + 0.3 = 1.0
    expect(scoreMemory(r, ['alpha', 'beta', 'gamma'], NOW)).toBeCloseTo(1.0, 6);
    // No keyword signal: 0.7
    expect(scoreMemory(r, [], NOW)).toBeCloseTo(0.7, 6);
  });
});

describe('relevanceRetrieve', () => {
  it('merges scopes and filters run memories to the current run', async () => {
    const store = fakeStore([
      rec({ key: 'studio-fact', scope: 'studio', projectId: null, salience: 0.9 }),
      rec({ key: 'proj-fact', scope: 'project', projectId: 'proj_1', salience: 0.9 }),
      rec({ key: 'other-proj', scope: 'project', projectId: 'proj_2', salience: 0.9 }),
      rec({ key: 'my-run', scope: 'run', runId: 'run_1', salience: 0.9 }),
      rec({ key: 'other-run', scope: 'run', runId: 'run_2', salience: 0.9 }),
    ]);
    const out = await relevanceRetrieve(store, {
      scope: 'all',
      projectId: 'proj_1',
      runId: 'run_1',
      query: 'facts',
      limit: 8,
      nowMs: NOW,
    });
    const keys = out.map((m) => m.key).sort();
    expect(keys).toEqual(['my-run', 'proj-fact', 'studio-fact']);
  });
});

describe('formatMemoriesForPrompt', () => {
  it('emits a compact tagged block', () => {
    const out = formatMemoriesForPrompt([
      rec({ key: 'prefers-dark', scope: 'project', content: 'user likes dark UI' }),
    ]);
    expect(out).toContain('<memory scope="project" key="prefers-dark">user likes dark UI</memory>');
  });
  it('returns empty string for no memories', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
  });
  it('escapes attribute quotes', () => {
    const out = formatMemoriesForPrompt([rec({ key: 'a"b', content: 'c' })]);
    expect(out).toContain('key="a&quot;b"');
  });
});

describe('remember validation', () => {
  it('rejects bad scope', () => {
    const p = rememberArgsSchema.safeParse({ scope: 'studio', key: 'k', content: 'c' });
    expect(p.success).toBe(false);
  });
  it('rejects oversize content', () => {
    const p = rememberArgsSchema.safeParse({
      scope: 'run',
      key: 'k',
      content: 'x'.repeat(8001),
    });
    expect(p.success).toBe(false);
  });
  it('rejects oversize key and bad salience', () => {
    expect(
      rememberArgsSchema.safeParse({ scope: 'run', key: 'k'.repeat(121), content: 'c' }).success,
    ).toBe(false);
    expect(
      rememberArgsSchema.safeParse({ scope: 'run', key: 'k', content: 'c', salience: 1.5 }).success,
    ).toBe(false);
  });
});

describe('executeRemember', () => {
  it('maps run scope to runId and project scope to projectId', async () => {
    const store = fakeStore([]);
    const redactor = createSecretRedactor();
    await executeRemember(
      { scope: 'run', key: 'k1', content: 'c1' },
      { runId: 'run_1', projectId: 'proj_1', redactor, memory: store },
    );
    await executeRemember(
      { scope: 'project', key: 'k2', content: 'c2' },
      { runId: 'run_1', projectId: 'proj_1', redactor, memory: store },
    );
    const [w1, w2] = store.written as Array<{ scope: string; runId: unknown; projectId: unknown }>;
    expect(w1!.scope).toBe('run');
    expect(w1!.runId).toBe('run_1');
    expect(w1!.projectId).toBeNull();
    expect(w2!.scope).toBe('project');
    expect(w2!.projectId).toBe('proj_1');
    expect(w2!.runId).toBeNull();
  });

  it('redacts secrets before writing', async () => {
    const store = fakeStore([]);
    const redactor = createSecretRedactor();
    redactor.addSecret('api-key', 'sk-live-12345');
    await executeRemember(
      { scope: 'run', key: 'k', content: 'the key is sk-live-12345 ok' },
      { runId: 'run_1', projectId: 'proj_1', redactor, memory: store },
    );
    const [w] = store.written as Array<{ content: string }>;
    expect(w!.content).not.toContain('sk-live-12345');
  });
});
