import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildStatus } from '@gameforge/shared';

const mocks = vi.hoisted(() => ({
  runBuildPipeline: vi.fn(),
  createBrowser: vi.fn(),
  createPgBuildStore: vi.fn(),
}));

vi.mock('@gameforge/test-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('@gameforge/test-runner')>();
  return { ...original, runBuildPipeline: mocks.runBuildPipeline };
});
vi.mock('../src/browser.js', () => ({ createBrowser: mocks.createBrowser }));
vi.mock('../src/buildStore.js', () => ({ createPgBuildStore: mocks.createPgBuildStore }));

import { processBuild } from '../src/buildProcessor.js';

describe('processBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPgBuildStore.mockReturnValue({});
    mocks.createBrowser.mockResolvedValue({ close: vi.fn() });
    mocks.runBuildPipeline.mockResolvedValue({
      verdict: BuildStatus.VERIFIED,
      results: [{ name: 'persist', status: 'pass', notes: '1 dist file persisted' }],
    });
  });

  it('runs the complete pipeline for a static game without package.json', async () => {
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text.includes('SELECT status, run_id')) {
          return { rows: [{ status: 'queued', run_id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    const result = await processBuild(
      { data: { buildId: 'build_01STATIC', projectId: 'project-static', revisionSha: 'a'.repeat(40) } },
      {
        pool: pool as never,
        redactor: { redactDeep: (value: unknown) => value } as never,
        log: vi.fn(),
        storageRoot: '/tmp/gameforge-static-test',
      },
    );

    expect(result).toEqual({ outcome: 'completed' });
    expect(mocks.runBuildPipeline).toHaveBeenCalledOnce();
    expect(mocks.runBuildPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: expect.stringContaining('project-static'),
        buildId: 'build_01STATIC',
      }),
    );
    expect(queries.some((q) => q.text.includes("verdict = '\"verified\"'"))).toBe(false);
  });

  it('persists a concise failed phase and diagnostic for the Studio UI', async () => {
    mocks.runBuildPipeline.mockResolvedValueOnce({
      verdict: BuildStatus.FAILED,
      results: [
        { name: 'validateStructure', status: 'pass', durationMs: 1 },
        {
          name: 'bundle',
          status: 'fail',
          durationMs: 2,
          error: 'vite could not resolve socket.io-client\n    at src/socket.ts:1:1',
        },
        { name: 'verdict', status: 'pass', durationMs: 1 },
      ],
      buildDir: '/tmp/build-failed',
    });
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text.includes('SELECT status, run_id')) {
          return { rows: [{ status: 'queued', run_id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    const result = await processBuild(
      { data: { buildId: 'build_01FAILED', projectId: 'project-failed', revisionSha: 'b'.repeat(40) } },
      {
        pool: pool as never,
        redactor: { redactDeep: (value: unknown) => value } as never,
        log: vi.fn(),
        storageRoot: '/tmp/gameforge-failed-test',
      },
    );

    expect(result).toEqual({ outcome: 'failed' });
    const update = queries.find((q) => q.text.includes('verdict = $3'))!;
    const verdict = JSON.parse(String(update.params?.[2])) as Record<string, unknown>;
    expect(verdict.failed_phase).toBe('bundle');
    expect(verdict.summary).toContain('socket.io-client');
  });
});
