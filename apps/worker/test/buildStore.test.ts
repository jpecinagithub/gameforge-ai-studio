import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPgBuildStore } from '../src/buildStore.js';
import type { DbPool } from '../src/db.js';

const roots: string[] = [];
const poolWith = (query: DbPool['query']): DbPool => ({
  query,
  connect: async () => ({ query, release: () => undefined }),
  end: async () => undefined,
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createPgBuildStore', () => {
  it('updates the API-created build row instead of inserting without project_id', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const root = mkdtempSync(path.join(tmpdir(), 'gf-store-'));
    roots.push(root);
    const store = createPgBuildStore(poolWith(
      async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    ), root);

    await store.saveBuildJob({
      buildId: 'build_01TEST',
      projectDir: '/project',
      revision: 'a'.repeat(40),
      status: 'verified',
      startedAt: new Date(0).toISOString(),
    });

    expect(calls[0]?.text.trim()).toMatch(/^UPDATE build_jobs SET/);
    expect(calls[0]?.text).not.toContain('INSERT INTO build_jobs');
  });

  it('preserves nested dist paths and stores a build-relative DB path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gf-store-'));
    roots.push(root);
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const store = createPgBuildStore(poolWith(
      async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [{ id: 'artifact-id' }], rowCount: 1 };
      },
    ), root);

    await store.saveArtifact('build_01TEST', {
      kind: 'dist',
      name: 'dist/assets/index.js',
      data: Buffer.from('ok'),
    });

    expect(readFileSync(path.join(root, 'artifacts', 'build_01TEST', 'dist', 'assets', 'index.js'), 'utf8')).toBe('ok');
    expect(calls[0]?.values?.[2]).toBe('dist/assets/index.js');
  });

  it('rejects path traversal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gf-store-'));
    roots.push(root);
    const store = createPgBuildStore(poolWith(
      async () => ({ rows: [], rowCount: 1 }),
    ), root);
    await expect(store.saveArtifact('build_01TEST', {
      kind: 'dist',
      name: '../escape.txt',
      data: Buffer.from('no'),
    })).rejects.toThrow('unsafe artifact path');
  });
});
