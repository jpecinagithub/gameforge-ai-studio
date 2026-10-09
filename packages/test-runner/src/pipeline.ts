/**
 * Game build pipeline — the 15 phases of master prompt §11 as an ordered array,
 * plus `visualReview` (Phase 6): the optional semantic visual review, gated on
 * a LIVE verified vision-capable model. Unverified visual reviews SKIP (never
 * fail the build); deterministic checks continue regardless.
 *
 * CONTRACT DECISIONS (rationale documented):
 * 1. Phase order follows §11 exactly. consoleCheck/networkCheck assert ZERO
 *    boot-time errors (collected during chromiumSmoke); gameplaySmoke then runs
 *    the full seeded evidence pass (playthrough + cameras + probes). Splitting
 *    "boot assertions" from "playthrough evidence" keeps phases single-purpose.
 * 2. Shadow build: the project is copied to an ephemeral buildDir (excluding
 *    node_modules/dist/.git/.studio); the source tree is NEVER built in place
 *    (adapted-from-Genex). Content-keyed memoization of buildDir is the CALLER's
 *    job; this pipeline only guarantees it never touches projectDir.
 * 3. Verdict rule: any failed phase → 'failed'. Any REQUIRED phase skipped →
 *    'partial'. Zero optional phases passed (all skipped) → 'partial' (a build
 *    that verified nothing is not 'verified'). Otherwise 'verified'.
 * 4. lastGood handling is the CALLER's responsibility: this pipeline reports the
 *    verdict and preserves diagnostics; the worker decides what goes live.
 * 5. BuildStore is an interface YOU inject. The Postgres implementation lands in
 *    the worker wiring (Phase 3b) — this package never imports pg.
 * 6. No-build templates are first-class (adapted-from-Genex): bundle skips with a
 *    note and the static tree is served as-is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildStatus, ReviewResultValue } from '@gameforge/shared';
import { runVisualReview, type VisualReviewDeps } from './visualReview.js';
import { serveGame, type PageServer } from './pageServer.js';
import {
  gatherEvidence,
  type BrowserLike,
  type BrowserPageLike,
  type EvidenceReport,
  type ScriptAction,
} from './evidence.js';
export type { BrowserLike, BrowserPageLike };

export type PhaseStatus = 'pass' | 'fail' | 'skip';

export interface PhaseResult {
  name: string;
  status: PhaseStatus;
  notes?: string;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: string;
}

export interface RunnerLike {
  exec(opts: {
    capability: 'install' | 'build' | 'test' | 'typecheck';
    cwd: string;
    command: string[];
    env?: Record<string, string>;
    timeoutMs: number;
    network?: 'none' | 'registry-only';
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

export interface BuildRecord {
  buildId: string;
  projectDir: string;
  revision: string;
  status: BuildStatus;
  startedAt: string;
  endedAt?: string;
  verdictNotes?: string;
}

/** Persistence boundary. pg implementation lands in worker wiring (Phase 3b). */
export interface BuildStore {
  saveBuildJob(rec: BuildRecord): Promise<void>;
  saveTestResult(
    buildId: string,
    r: { suite: string; name: string; status: 'pass' | 'fail' | 'skip'; durationMs: number; details?: unknown },
  ): Promise<void>;
  saveReviewResult(
    buildId: string,
    r: {
      criterion: string;
      result: ReviewResultValue;
      confidence?: number;
      evidence?: unknown;
      issue?: string;
      recommendation?: string;
      retestRequired?: boolean;
    },
  ): Promise<void>;
  /** Returns an artifact reference/id. */
  saveArtifact(
    buildId: string,
    a: { kind: string; name: string; data: Buffer; metadata?: unknown },
  ): Promise<string>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  check: 'console-clean' | 'no-failed-requests' | 'non-blank' | 'state-changed' | 'manual';
}

/** Template contract (adapted-from-Genex studio.json contractVersion idea). */
export interface StudioJson {
  entry?: string;
  main?: string;
  build?: string;
  bootMs?: number;
  cameras?: string[];
  seed?: number;
  scripts?: ScriptAction[];
}

export interface PhaseContext {
  projectDir: string;
  buildDir: string;
  distDir: string;
  buildId: string;
  revision: string;
  seed: number;
  bootMs: number;
  cameras: string[];
  script: ScriptAction[];
  criteria: AcceptanceCriterion[];
  studioJson: StudioJson;
  runner: RunnerLike;
  browser: BrowserLike;
  store: BuildStore;
  server?: PageServer;
  smokePage?: BrowserPageLike;
  bootConsoleErrors: { type: string; text: string }[];
  bootFailedRequests: { url: string; failure: string }[];
  evidence?: EvidenceReport;
  verdict?: BuildStatus;
  results: PhaseResult[];
  /**
   * Optional vision deps for the semantic visual review phase. When absent,
   * visualReview skips honestly (review labeled unverified) — the pipeline
   * never fabricates a semantic review.
   */
  vision?: VisualReviewDeps;
  /** Epoch ms when the pipeline started (for build record timestamps). */
  startedAt: number;
}

export interface Phase {
  name: string;
  /** Required phases can never be skipped without forcing 'partial'. */
  required: boolean;
  run(ctx: PhaseContext): Promise<Omit<PhaseResult, 'name' | 'durationMs'>>;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // Genex checkpoint limit, adapted
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.studio']);

function phaseResult(
  status: PhaseStatus,
  notes?: string,
  extra?: Partial<PhaseResult>,
): Omit<PhaseResult, 'name' | 'durationMs'> {
  return { status, ...(notes ? { notes } : {}), ...extra };
}

function readStudioJson(dir: string): StudioJson {
  try {
    const raw = fs.readFileSync(path.join(dir, 'studio.json'), 'utf8');
    const parsed = JSON.parse(raw) as StudioJson;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      copyTree(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
    // Symlinks and others are deliberately NOT copied (traversal defense).
  }
}

function walkFiles(dir: string, out: string[] = [], base = dir): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out, base);
    else if (entry.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

const validateStructure: Phase = {
  name: 'validateStructure',
  required: true,
  async run(ctx) {
    const entry = ctx.studioJson.entry ?? 'index.html';
    if (!fs.existsSync(path.join(ctx.buildDir, entry))) {
      return phaseResult('fail', `entry document missing: ${entry}`, {
        error: `required file not found: ${entry}`,
      });
    }
    if (ctx.studioJson.main && !fs.existsSync(path.join(ctx.buildDir, ctx.studioJson.main))) {
      return phaseResult('fail', `declared main missing: ${ctx.studioJson.main}`, {
        error: `studio.json main not found: ${ctx.studioJson.main}`,
      });
    }
    return phaseResult('pass', `entry=${entry}`);
  },
};

const validateFiles: Phase = {
  name: 'validateFiles',
  required: true,
  async run(ctx) {
    const files = walkFiles(ctx.buildDir);
    for (const rel of files) {
      if (rel.includes('..') || path.isAbsolute(rel)) {
        return phaseResult('fail', `unsafe path: ${rel}`, { error: 'path traversal detected' });
      }
      const size = fs.statSync(path.join(ctx.buildDir, rel)).size;
      if (size > MAX_FILE_BYTES) {
        return phaseResult('fail', `file exceeds 50 MiB cap: ${rel}`, {
          error: `oversized file: ${rel}`,
        });
      }
    }
    const hasEnv = files.some((f) => path.basename(f) === '.env');
    return phaseResult(
      'pass',
      `${files.length} files, all within caps${hasEnv ? ' (note: .env present — never packaged)' : ''}`,
      { data: { fileCount: files.length } },
    );
  },
};

const install: Phase = {
  name: 'install',
  required: false,
  async run(ctx) {
    const pkg = readPackageJson(ctx.buildDir);
    if (!pkg) return phaseResult('skip', 'no package.json — nothing to install');
    const useCi = fs.existsSync(path.join(ctx.buildDir, 'package-lock.json'));
    const command = useCi ? ['npm', 'ci', '--no-audit', '--no-fund'] : ['npm', 'install', '--no-audit', '--no-fund'];
    const r = await ctx.runner.exec({
      capability: 'install', cwd: ctx.buildDir, command,
      timeoutMs: 10 * 60 * 1000, network: 'registry-only',
    });
    if (r.timedOut || r.exitCode !== 0) {
      return phaseResult('fail', 'dependency install failed', {
        error: (r.stderr || r.stdout).slice(0, 4000),
      });
    }
    return phaseResult('pass', useCi ? 'npm ci' : 'npm install');
  },
};

const typecheck: Phase = {
  name: 'typecheck',
  required: false,
  async run(ctx) {
    if (!fs.existsSync(path.join(ctx.buildDir, 'tsconfig.json'))) {
      return phaseResult('skip', 'no tsconfig.json — nothing to typecheck');
    }
    const r = await ctx.runner.exec({
      capability: 'typecheck', cwd: ctx.buildDir,
      command: ['npx', '--no-install', 'tsc', '--noEmit'],
      timeoutMs: 5 * 60 * 1000, network: 'none',
    });
    if (r.timedOut || r.exitCode !== 0) {
      return phaseResult('fail', 'typecheck failed', {
        error: (r.stderr || r.stdout).slice(0, 4000),
      });
    }
    return phaseResult('pass', 'tsc --noEmit clean');
  },
};

const unitTests: Phase = {
  name: 'unitTests',
  required: false,
  async run(ctx) {
    const pkg = readPackageJson(ctx.buildDir);
    const scripts = (pkg?.['scripts'] as Record<string, string> | undefined) ?? {};
    if (!scripts['test']) return phaseResult('skip', 'no test script — nothing to run');
    const r = await ctx.runner.exec({
      capability: 'test', cwd: ctx.buildDir, command: ['npm', 'test'],
      timeoutMs: 10 * 60 * 1000, network: 'none',
    });
    if (r.timedOut || r.exitCode !== 0) {
      return phaseResult('fail', 'unit tests failed', {
        error: (r.stderr || r.stdout).slice(0, 4000),
      });
    }
    return phaseResult('pass', 'npm test green');
  },
};

const bundle: Phase = {
  name: 'bundle',
  required: false,
  async run(ctx) {
    const hasVite = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'].some((f) =>
      fs.existsSync(path.join(ctx.buildDir, f)),
    );
    const pkg = readPackageJson(ctx.buildDir);
    const scripts = (pkg?.['scripts'] as Record<string, string> | undefined) ?? {};
    if (hasVite || scripts['build']) {
      const command = hasVite ? ['npx', '--no-install', 'vite', 'build'] : ['npm', 'run', 'build'];
      const r = await ctx.runner.exec({
        capability: 'build', cwd: ctx.buildDir, command,
        timeoutMs: 10 * 60 * 1000, network: 'none',
      });
      if (r.timedOut || r.exitCode !== 0) {
        return phaseResult('fail', 'bundle failed', {
          error: (r.stderr || r.stdout).slice(0, 4000),
        });
      }
      ctx.distDir = path.join(ctx.buildDir, 'dist');
      return phaseResult('pass', 'vite build → dist/');
    }
    // No-build template (adapted-from-Genex): serve the static tree as-is.
    ctx.distDir = ctx.buildDir;
    return phaseResult('skip', 'no bundler configured — serving static tree');
  },
};

const previewServer: Phase = {
  name: 'previewServer',
  required: true,
  async run(ctx) {
    ctx.server = await serveGame(ctx.distDir, { entry: ctx.studioJson.entry ?? 'index.html' });
    return phaseResult('pass', ctx.server.url, { data: { url: ctx.server.url } });
  },
};

const READY_EXPR =
  `Boolean(window.__studio && typeof window.__studio.ready === 'function' && window.__studio.ready() !== 'loading')`;

const chromiumSmoke: Phase = {
  name: 'chromiumSmoke',
  required: true,
  async run(ctx) {
    if (!ctx.server) return phaseResult('fail', 'no preview server', { error: 'previewServer did not run' });
    const page = await ctx.browser.newPage();
    ctx.smokePage = page;
    page.onConsole((type, text) => {
      if (type === 'error') ctx.bootConsoleErrors.push({ type, text: text.slice(0, 2000) });
    });
    page.onRequestFailed((url, failure) => {
      ctx.bootFailedRequests.push({ url: url.slice(0, 500), failure: failure.slice(0, 500) });
    });
    try {
      await page.goto(ctx.server.url);
      await page.waitForFunction(READY_EXPR, ctx.bootMs);
    } catch (err) {
      return phaseResult('fail', 'page did not become ready within bootMs', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const hasStudio = await page.evaluate<boolean>(`Boolean(window.__studio)`);
    if (!hasStudio) {
      return phaseResult('fail', 'window.__studio contract missing', {
        error: 'shim not installed or overwritten',
      });
    }
    return phaseResult('pass', 'page ready, __studio present');
  },
};

const consoleCheck: Phase = {
  name: 'consoleCheck',
  required: true,
  async run(ctx) {
    if (ctx.bootConsoleErrors.length > 0) {
      return phaseResult('fail', `${ctx.bootConsoleErrors.length} console error(s) at boot`, {
        error: ctx.bootConsoleErrors.slice(0, 5).map((e) => e.text).join('\n'),
        data: { count: ctx.bootConsoleErrors.length },
      });
    }
    return phaseResult('pass', 'zero console errors at boot');
  },
};

const networkCheck: Phase = {
  name: 'networkCheck',
  required: true,
  async run(ctx) {
    if (ctx.bootFailedRequests.length > 0) {
      return phaseResult('fail', `${ctx.bootFailedRequests.length} failed request(s) at boot`, {
        error: ctx.bootFailedRequests.slice(0, 5).map((r) => `${r.url}: ${r.failure}`).join('\n'),
        data: { count: ctx.bootFailedRequests.length },
      });
    }
    return phaseResult('pass', 'zero failed requests at boot');
  },
};

const gameplaySmoke: Phase = {
  name: 'gameplaySmoke',
  required: false,
  async run(ctx) {
    if (!ctx.server) return phaseResult('fail', 'no preview server', { error: 'previewServer did not run' });
    const page = await ctx.browser.newPage();
    const { report, classification } = await gatherEvidence({
        page,
        url: ctx.server.url,
        seed: ctx.seed,
        cameras: ctx.cameras,
        script: ctx.script,
        bootMs: ctx.bootMs,
      });
      ctx.evidence = report;
      if (classification === 'OBSERVATION_DOWN') {
        return phaseResult('fail', 'observation down — retry, not charged to build', {
          error: 'OBSERVATION_DOWN',
        });
      }
      if (classification === 'BUILD_BROKEN') {
        const why = report.consoleErrors[0]?.text
          ?? report.failedRequests[0]?.url
          ?? (report.shots.length > 0 ? 'blank output (near-black frames)' : 'evidence failed');
        return phaseResult('fail', `gameplay smoke failed: ${why}`, {
          error: why,
          data: {
            consoleErrors: report.consoleErrors.length,
            failedRequests: report.failedRequests.length,
          },
        });
      }
      // State must change across the scripted playthrough (deterministic sim).
      const states = report.states.map((s) => s.stateJson);
      const changed = states.length >= 2 && states[0] !== states[states.length - 1];
      if (!changed) {
        return phaseResult('fail', 'game state did not change during scripted playthrough', {
          error: 'state-changed assertion failed',
        });
      }
      return phaseResult('pass', `${report.shots.length} camera(s), state changed, evidence clean`, {
        data: { shots: report.shots.length, drawCalls: report.drawCalls },
      });
    // Note: BrowserPageLike has no close(); the browser pool reclaims pages.
  },
};

const screenshots: Phase = {
  name: 'screenshots',
  required: false,
  async run(ctx) {
    const shots = ctx.evidence?.shots ?? [];
    if (shots.length === 0) {
      return phaseResult('skip', 'no evidence shots to persist (gameplaySmoke skipped or failed)');
    }
    const refs: string[] = [];
    for (const shot of shots) {
      const ref = await ctx.store.saveArtifact(ctx.buildId, {
        kind: 'screenshot',
        name: `${shot.camera}.png`,
        data: shot.png,
        metadata: { camera: shot.camera, stats: shot.stats, seed: ctx.evidence?.seed },
      });
      refs.push(ref);
    }
    return phaseResult('pass', `${refs.length} screenshot(s) persisted`, { data: { refs } });
  },
};

const visualReview: Phase = {
  name: 'visualReview',
  required: false,
  async run(ctx) {
    const shots = (ctx.evidence?.shots ?? []).map((s) => ({
      camera: s.camera,
      png: s.png,
    }));
    if (!ctx.vision) {
      await ctx.store.saveReviewResult(ctx.buildId, {
        criterion: 'semantic-visual-review',
        result: 'unverified',
        issue: 'semantic review not performed — vision deps not configured',
      });
      return phaseResult('skip', 'vision deps not configured — semantic review unavailable');
    }
    const outcome = await runVisualReview(ctx.vision, {
      shots,
      criteria: ctx.criteria.map((c) => ({ id: c.id, description: c.description })),
      saveReviewResult: (row) => ctx.store.saveReviewResult(ctx.buildId, row),
    });
    if (outcome.status === 'verified') {
      return phaseResult(
        'pass',
        `semantic visual review verified by ${outcome.modelId} (${outcome.rows.length} criteria)`,
      );
    }
    // Unverified is a SKIP, not a failure: deterministic checks already ran
    // and the review row carries the explicit reason. A failed semantic review
    // never fails the build by itself.
    return phaseResult('skip', `semantic visual review unverified: ${outcome.reason}`);
  },
};

function evaluateCriterion(
  c: AcceptanceCriterion,
  evidence?: EvidenceReport,
): { result: ReviewResultValue; evidence?: unknown; issue?: string } {
  switch (c.check) {
    case 'manual':
      return { result: 'unverified', issue: 'requires human or judge review' };
    case 'console-clean':
      if (!evidence) return { result: 'unverified', issue: 'no evidence gathered' };
      return evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0
        ? { result: 'pass' }
        : { result: 'fail', issue: `${evidence.consoleErrors.length} console error(s)` };
    case 'no-failed-requests':
      if (!evidence) return { result: 'unverified', issue: 'no evidence gathered' };
      return evidence.failedRequests.length === 0
        ? { result: 'pass' }
        : { result: 'fail', issue: `${evidence.failedRequests.length} failed request(s)` };
    case 'non-blank':
      if (!evidence || evidence.shots.length === 0) {
        return { result: 'unverified', issue: 'no screenshots' };
      }
      return evidence.shots.every((s) => s.stats.nearBlackFraction <= 0.85)
        ? { result: 'pass', evidence: { shots: evidence.shots.map((s) => ({ camera: s.camera, stats: s.stats })) } }
        : { result: 'fail', issue: 'blank output detected (near-black frames)' };
    case 'state-changed': {
      if (!evidence || evidence.states.length < 2) {
        return { result: 'unverified', issue: 'insufficient state snapshots' };
      }
      const states = evidence.states.map((s) => s.stateJson);
      return states[0] !== states[states.length - 1]
        ? { result: 'pass' }
        : { result: 'fail', issue: 'state did not change' };
    }
  }
}

const acceptanceEval: Phase = {
  name: 'acceptanceEval',
  required: false,
  async run(ctx) {
    if (ctx.criteria.length === 0) {
      return phaseResult('skip', 'no acceptance criteria configured');
    }
    let failed = 0;
    for (const c of ctx.criteria) {
      const r = evaluateCriterion(c, ctx.evidence);
      await ctx.store.saveReviewResult(ctx.buildId, {
        criterion: `${c.id}: ${c.description}`,
        result: r.result,
        evidence: r.evidence,
        issue: r.issue,
        retestRequired: r.result === 'fail',
      });
      if (r.result === 'fail') failed += 1;
    }
    if (failed > 0) {
      return phaseResult('fail', `${failed}/${ctx.criteria.length} acceptance criteria failed`, {
        error: 'acceptance criteria failed',
        data: { failed, total: ctx.criteria.length },
      });
    }
    return phaseResult('pass', `${ctx.criteria.length} acceptance criteria evaluated`);
  },
};

const verdictPhase: Phase = {
  name: 'verdict',
  required: true,
  async run(ctx) {
    const done = ctx.results; // phases so far (verdict itself not yet included)
    if (done.some((r) => r.status === 'fail')) {
      ctx.verdict = BuildStatus.FAILED;
      return phaseResult('pass', 'verdict=failed', { data: { verdict: ctx.verdict } });
    }
    if (done.some((r) => r.status === 'skip' && isRequired(r.name))) {
      ctx.verdict = BuildStatus.PARTIAL;
      return phaseResult('pass', 'verdict=partial (required phase skipped)', {
        data: { verdict: ctx.verdict },
      });
    }
    const optionalPassed = done.some((r) => r.status === 'pass' && !isRequired(r.name));
    ctx.verdict = optionalPassed ? BuildStatus.VERIFIED : BuildStatus.PARTIAL;
    return phaseResult(
      'pass',
      `verdict=${ctx.verdict}${optionalPassed ? '' : ' (no optional verification ran)'}`,
      { data: { verdict: ctx.verdict } },
    );
  },
};

function isRequired(name: string): boolean {
  return DEFAULT_PHASES.find((p) => p.name === name)?.required ?? false;
}

const persist: Phase = {
  name: 'persist',
  required: true,
  async run(ctx) {
    const t0 = Date.now();
    const verdict = ctx.verdict ?? BuildStatus.FAILED;
    await ctx.store.saveBuildJob({
      buildId: ctx.buildId,
      projectDir: ctx.projectDir,
      revision: ctx.revision,
      status: verdict,
      startedAt: new Date(ctx.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      verdictNotes: ctx.results.find((r) => r.name === 'verdict')?.notes,
    });
    for (const r of ctx.results) {
      await ctx.store.saveTestResult(ctx.buildId, {
        suite: 'pipeline',
        name: r.name,
        status: r.status,
        durationMs: r.durationMs,
        details: { notes: r.notes, error: r.error, data: r.data },
      });
    }
    const selfResult: PhaseResult = {
      name: 'persist',
      status: 'pass',
      durationMs: Date.now() - t0,
      notes: `build job persisted as ${verdict}`,
    };
    await ctx.store.saveTestResult(ctx.buildId, {
      suite: 'pipeline',
      name: 'persist',
      status: 'pass',
      durationMs: selfResult.durationMs,
      details: { notes: selfResult.notes },
    });
    await ctx.store.saveArtifact(ctx.buildId, {
      kind: 'report',
      name: 'phase-results.json',
      data: Buffer.from(JSON.stringify([...ctx.results, selfResult], null, 2), 'utf8'),
    });
    // Persist the built game files (verified/partial only) so the preview
    // origin can serve them. A failed build keeps its diagnostics but no
    // playable files — last-good stays authoritative.
    let distFiles = 0;
    if (verdict === BuildStatus.VERIFIED || verdict === BuildStatus.PARTIAL) {
      for (const rel of listFilesRecursive(ctx.distDir).slice(0, 500)) {
        const abs = path.join(ctx.distDir, rel);
        const stat = fs.statSync(abs);
        if (stat.size > 25 * 1024 * 1024) continue; // sanity cap per file
        await ctx.store.saveArtifact(ctx.buildId, {
          kind: 'dist',
          name: `dist/${rel.split(path.sep).join('/')}`,
          data: fs.readFileSync(abs),
          metadata: { bytes: stat.size },
        });
        distFiles++;
      }
    }
    return phaseResult('pass', `build job persisted as ${verdict} (${distFiles} dist file(s))`);
  },
};

/** Relative file paths under dir (no directories, no symlinks followed). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

export const DEFAULT_PHASES: Phase[] = [
  validateStructure,
  validateFiles,
  install,
  typecheck,
  unitTests,
  bundle,
  previewServer,
  chromiumSmoke,
  consoleCheck,
  networkCheck,
  gameplaySmoke,
  screenshots,
  visualReview,
  acceptanceEval,
  verdictPhase,
  persist,
];

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export interface RunBuildOptions {
  projectDir: string;
  buildId: string;
  revision?: string;
  runner: RunnerLike;
  browser: BrowserLike;
  store: BuildStore;
  /** Shadow dir. Defaults to os.tmpdir()/gameforge-build-<buildId>. */
  buildDir?: string;
  phases?: Phase[];
  seed?: number;
  bootMs?: number;
  cameras?: string[];
  script?: ScriptAction[];
  criteria?: AcceptanceCriterion[];
  /** Keep the shadow dir after the run (debugging). Default false. */
  keepBuildDir?: boolean;
  /** Per-phase timeout. Default 20 min. */
  phaseTimeoutMs?: number;
  /** Semantic visual review deps. Absent → phase skips honestly (unverified). */
  vision?: VisualReviewDeps;
}

export interface BuildPipelineResult {
  verdict: BuildStatus;
  results: PhaseResult[];
  evidence?: EvidenceReport;
  buildDir: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`phase timed out after ${ms}ms: ${name}`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runBuildPipeline(
  options: RunBuildOptions,
): Promise<BuildPipelineResult> {
  const {
    projectDir, buildId, runner, browser, store,
    phases = DEFAULT_PHASES,
    seed = 1234,
    bootMs = 15000,
    cameras,
    script,
    criteria = [],
    keepBuildDir = false,
    phaseTimeoutMs = 20 * 60 * 1000,
    vision,
  } = options;

  const startedAt = Date.now();
  const buildDir = options.buildDir ?? path.join(os.tmpdir(), `gameforge-build-${buildId}`);

  // Shadow build: copy source tree; never build in place.
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
  copyTree(path.resolve(projectDir), buildDir);

  const studioJson = readStudioJson(buildDir);
  const ctx: PhaseContext & { startedAt: number } = {
    projectDir: path.resolve(projectDir),
    buildDir,
    distDir: buildDir,
    buildId,
    revision: options.revision ?? 'unknown',
    seed: options.seed ?? studioJson.seed ?? seed,
    bootMs: studioJson.bootMs ?? bootMs,
    cameras: cameras ?? studioJson.cameras ?? ['default'],
    script: script ?? studioJson.scripts ?? [{ steps: 60, dtMs: 16.666 }],
    criteria,
    studioJson,
    runner,
    browser,
    store,
    bootConsoleErrors: [],
    bootFailedRequests: [],
    results: [],
    startedAt,
    vision,
  };

  try {
    let failed = false;
    for (const phase of phases) {
      // After a failure, verification work stops — but 'verdict' and 'persist'
      // ALWAYS run so a failed build still gets its verdict and its record.
      // (A build with no persisted job is a build that never happened.)
      if (failed && phase.name !== 'verdict' && phase.name !== 'persist') continue;
      const t0 = Date.now();
      let result: PhaseResult;
      try {
        const partial = await withTimeout(phase.run(ctx), phaseTimeoutMs, phase.name);
        result = { name: phase.name, durationMs: Date.now() - t0, ...partial };
      } catch (err) {
        result = {
          name: phase.name,
          status: 'fail',
          durationMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      ctx.results.push(result);
      if (result.status === 'fail') failed = true;
    }
  } finally {
    try {
      await ctx.server?.close();
    } catch { /* ignore */ }
    if (!keepBuildDir) {
      try {
        fs.rmSync(buildDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  const verdictResult = ctx.results.find((r) => r.name === 'verdict');
  const verdict = (verdictResult?.data?.['verdict'] as BuildStatus | undefined)
    ?? (ctx.results.some((r) => r.status === 'fail') ? BuildStatus.FAILED : BuildStatus.PARTIAL);

  return { verdict, results: ctx.results, evidence: ctx.evidence, buildDir };
}
