/**
 * pipeline tests — all external systems mocked (runner, browser, store).
 * No Docker, no Chromium, no Postgres needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { BuildStatus } from '@gameforge/shared';
import {
  runBuildPipeline,
  DEFAULT_PHASES,
  type Phase,
  type PhaseContext,
  type RunnerLike,
  type BrowserLike,
  type BrowserPageLike,
  type BuildStore,
} from './pipeline.js';

function whitePng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < 4; i++) {
    png.data[i * 4] = 255; png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function mockRunner(failCapability?: string): RunnerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: async (opts) => {
      calls.push(opts.capability);
      if (failCapability === opts.capability) {
        return { exitCode: 1, stdout: '', stderr: 'SYNTHETIC TYPE ERROR: boom', timedOut: false };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  };
}

function mockPage(): BrowserPageLike {
  let tick = 0;
  return {
    goto: async () => {},
    evaluate: (async <T>(expr: string): Promise<T> => {
      if (expr.includes('__studio.ready') || expr.includes('Boolean(window.__studio)')) return true as T;
      if (expr.includes('__studio.step')) { tick += 1; return null as T; }
      if (expr.includes('__studio.state')) return JSON.stringify({ tick }) as T;
      if (expr.includes('__studio.drawCalls')) return 5 as T;
      if (expr.includes('__studio.errors')) return [] as T;
      return null as T;
    }) as BrowserPageLike['evaluate'],
    screenshot: async () => whitePng(),
    keyboard: { press: async () => {}, down: async () => {}, up: async () => {} },
    waitForFunction: async () => {},
    onConsole: () => {},
    onRequestFailed: () => {},
    isClosed: () => false,
  };
}

function mockBrowser(): BrowserLike {
  return { newPage: async () => mockPage(), close: async () => {} };
}

function mockStore() {
  const jobs: any[] = [];
  const tests: any[] = [];
  const reviews: any[] = [];
  const artifacts: any[] = [];
  const store: BuildStore = {
    saveBuildJob: async (r) => { jobs.push(r); },
    saveTestResult: async (id, r) => { tests.push({ id, ...r }); },
    saveReviewResult: async (id, r) => { reviews.push({ id, ...r }); },
    saveArtifact: async (id, a) => { artifacts.push({ id, ...a }); return `art_${artifacts.length}`; },
  };
  return { store, jobs, tests, reviews, artifacts };
}

const INDEX_HTML = '<!DOCTYPE html><html><head></head><body><script type="module" src="/m.js"></script></body></html>';

function fixtureProject(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gf-pipe-'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'studio.json'), JSON.stringify({ entry: 'index.html', cameras: ['main'] }));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'excluded.txt'), 'must not be copied');
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('runBuildPipeline', () => {
  it('runs phases in order and stops at the first failure with verdict failed', async () => {
    const projectDir = fixtureProject({ 'tsconfig.json': '{}' });
    dirs.push(projectDir);
    const runner = mockRunner('typecheck'); // typecheck fails
    const { store, jobs } = mockStore();

    const result = await runBuildPipeline({
      projectDir, buildId: 'build_order1', runner,
      browser: mockBrowser(), store,
      script: [{ steps: 2, dtMs: 16.666 }],
    });

    const names = result.results.map((r) => r.name);
    // Verification work stops at the failure; verdict + persist always run.
    expect(names).toEqual([
      'validateStructure', 'validateFiles', 'install', 'typecheck',
      'verdict', 'persist',
    ]);
    expect(result.verdict).toBe(BuildStatus.FAILED);
    // Diagnostic preserved on the failed phase.
    const failed = result.results.find((r) => r.name === 'typecheck')!;
    expect(failed.status).toBe('fail');
    expect(failed.error).toContain('SYNTHETIC TYPE ERROR');
    // Build job persisted as failed.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe(BuildStatus.FAILED);
    // Shadow dir cleaned up by default.
    expect(existsSync(result.buildDir)).toBe(false);
  });

  it('all-skipped optional phases → partial, not verified', async () => {
    const projectDir = fixtureProject(); // no package.json/tsconfig/vite → install/typecheck/unit/bundle skip
    dirs.push(projectDir);
    const runner = mockRunner();
    const { store, jobs } = mockStore();

    // Custom phase list: required structure + optional phases that all skip.
    const skipPhase = (name: string): Phase => ({
      name, required: false,
      run: async (_ctx: PhaseContext) => ({ status: 'skip' as const, notes: 'n/a' }),
    });
    const verdictPhase = DEFAULT_PHASES.find((p) => p.name === 'verdict')!;
    const persistPhase = DEFAULT_PHASES.find((p) => p.name === 'persist')!;
    const validateStructure = DEFAULT_PHASES.find((p) => p.name === 'validateStructure')!;

    const result = await runBuildPipeline({
      projectDir, buildId: 'build_partial1', runner,
      browser: mockBrowser(), store,
      phases: [validateStructure, skipPhase('install'), skipPhase('typecheck'), verdictPhase, persistPhase],
    });

    expect(result.verdict).toBe(BuildStatus.PARTIAL);
    expect(jobs[0].status).toBe(BuildStatus.PARTIAL);
  });

  it('full green run → verified, with artifacts persisted', async () => {
    const projectDir = fixtureProject();
    dirs.push(projectDir);
    const runner = mockRunner();
    const { store, jobs, artifacts, tests } = mockStore();

    const result = await runBuildPipeline({
      projectDir, buildId: 'build_green1', runner,
      browser: mockBrowser(), store,
      script: [{ steps: 2, dtMs: 16.666 }],
      criteria: [
        { id: 'c1', description: 'console clean', check: 'console-clean' },
        { id: 'c2', description: 'renders something', check: 'non-blank' },
      ],
    });

    expect(result.verdict).toBe(BuildStatus.VERIFIED);
    expect(result.evidence?.shots).toHaveLength(1);
    expect(jobs[0].status).toBe(BuildStatus.VERIFIED);
    // Every phase recorded as a test result; screenshots + report artifacts saved.
    expect(tests.length).toBe(result.results.length);
    expect(artifacts.some((a) => a.kind === 'screenshot')).toBe(true);
    expect(artifacts.some((a) => a.name === 'phase-results.json')).toBe(true);
  });

  it('shadow build never copies excluded dirs and never touches projectDir', async () => {
    const projectDir = fixtureProject();
    dirs.push(projectDir);
    const runner = mockRunner();
    const { store } = mockStore();
    const before = JSON.stringify([existsSync(join(projectDir, 'index.html'))]);

    const result = await runBuildPipeline({
      projectDir, buildId: 'build_shadow1', runner,
      browser: mockBrowser(), store, keepBuildDir: true,
      script: [{ steps: 2, dtMs: 16.666 }],
    });
    dirs.push(result.buildDir);

    expect(existsSync(join(result.buildDir, 'node_modules', 'excluded.txt'))).toBe(false);
    expect(existsSync(join(result.buildDir, 'index.html'))).toBe(true);
    expect(JSON.stringify([existsSync(join(projectDir, 'index.html'))])).toBe(before);
  });

  it('missing entry → validateStructure fails fast', async () => {
    const projectDir = fixtureProject();
    dirs.push(projectDir);
    const runner = mockRunner();
    const { store } = mockStore();

    const result = await runBuildPipeline({
      projectDir, buildId: 'build_nofile1', runner,
      browser: mockBrowser(), store,
      phases: [
        {
          name: 'validateStructure', required: true,
          run: async (ctx: PhaseContext) => {
            void ctx;
            return { status: 'fail' as const, error: 'entry document missing: nope.html' };
          },
        },
      ],
    });
    expect(result.results).toHaveLength(1);
    expect(result.verdict).toBe(BuildStatus.FAILED);
  });
});

describe('visualReview phase', () => {
  const visualReviewPhase = DEFAULT_PHASES.find((p) => p.name === 'visualReview')!;

  function phaseCtx(opts: {
    vision?: unknown;
    shots?: { camera: string; png: Buffer }[];
  }) {
    const { store, reviews } = mockStore();
    const ctx = {
      buildId: 'build_vision1',
      criteria: [{ id: 'c1', description: 'renders', check: 'manual' as const }],
      evidence: { shots: opts.shots ?? [] },
      store,
      vision: opts.vision,
    } as unknown as PhaseContext;
    return { ctx, reviews };
  }

  it('is registered as an optional phase after screenshots', () => {
    expect(visualReviewPhase).toBeDefined();
    expect(visualReviewPhase.required).toBe(false);
    const names = DEFAULT_PHASES.map((p) => p.name);
    expect(names.indexOf('visualReview')).toBeGreaterThan(names.indexOf('screenshots'));
    expect(names.indexOf('visualReview')).toBeLessThan(names.indexOf('acceptanceEval'));
  });

  it('skips honestly when vision deps are not configured, labeling the review unverified', async () => {
    const { ctx, reviews } = phaseCtx({});
    const res = await visualReviewPhase.run(ctx);
    expect(res.status).toBe('skip');
    expect(res.notes).toContain('vision deps not configured');
    expect(reviews).toHaveLength(1);
    expect(reviews[0].result).toBe('unverified');
    expect(reviews[0].criterion).toBe('semantic-visual-review');
  });

  it('skips (never fails) when no vision-capable model is verified', async () => {
    const registry = {
      selectModel: () => {
        throw new Error('no vision');
      },
    } as never;
    const client = { chatCompletions: async () => { throw new Error('must not be called'); } } as never;
    const { ctx, reviews } = phaseCtx({
      vision: { registry, client },
      shots: [{ camera: 'main', png: whitePng() }],
    });
    const res = await visualReviewPhase.run(ctx);
    expect(res.status).toBe('skip');
    expect(res.notes).toContain('no verified vision-capable model');
    expect(reviews.some((r: { result: string }) => r.result === 'unverified')).toBe(true);
  });

  it('passes when a live vision model verified the review', async () => {
    const registry = { selectModel: () => 'test/vision' } as never;
    const client = {
      chatCompletions: async (call: { jsonMode?: boolean }) => {
        if (!call.jsonMode) {
          return { content: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 };
        }
        return {
          content: JSON.stringify({ criteria: [{ id: 'c1', result: 'pass', note: 'ok' }], issues: [] }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'm',
          latencyMs: 1,
        };
      },
    } as never;
    const { ctx, reviews } = phaseCtx({
      vision: { registry, client },
      shots: [{ camera: 'main', png: whitePng() }],
    });
    const res = await visualReviewPhase.run(ctx);
    expect(res.status).toBe('pass');
    expect(res.notes).toContain('test/vision');
    expect(reviews.some((r: { result: string; judgeModel?: string }) => r.result === 'pass' && r.judgeModel === 'test/vision')).toBe(true);
  });
});
