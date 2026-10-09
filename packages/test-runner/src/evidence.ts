/**
 * Deterministic evidence gathering (adapted-from-Genex `loop/evidence.ts`, MIT).
 *
 * One evidence pass = seeded playthrough + screenshots at every named camera +
 * structural probes + console/GPU error capture + model-free blank detection.
 *
 * Playwright is an OPTIONAL peer dependency: this module codes against the minimal
 * `BrowserPageLike` / `BrowserLike` interfaces below, so unit tests inject mocks and
 * the real Chromium pool (Oracle, Phase 3b wiring) injects Playwright pages.
 */
import { PNG } from 'pngjs';

export interface ConsoleEntry {
  type: string;
  text: string;
}

export interface FailedRequest {
  url: string;
  failure: string;
}

export interface PageErrorEntry {
  kind: string;
  message: string;
  time: number;
}

/** Minimal page surface. Implemented by Playwright's Page in production. */
export interface BrowserPageLike {
  goto(url: string): Promise<void>;
  /** Evaluate a JS *expression string* in the page (string keeps mocks trivial). */
  evaluate<T>(expression: string): Promise<T>;
  screenshot(): Promise<Buffer>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  waitForFunction(expression: string, timeoutMs: number): Promise<void>;
  onConsole(cb: (type: string, text: string) => void): void;
  onRequestFailed(cb: (url: string, failure: string) => void): void;
  isClosed(): boolean;
}

export interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export interface ScriptAction {
  /** Number of scripted ticks. */
  steps: number;
  /** Virtual ms per tick. */
  dtMs: number;
  /** Keys held during the action (pressed down, released after). */
  keys?: string[];
}

export interface GatherEvidenceOptions {
  page: BrowserPageLike;
  url: string;
  /** Deterministic seed (PAGE_SEED-style). Default 1234. */
  seed?: number;
  /** Named camera tags; the shim's capture(tag) is invoked before each shot. */
  cameras?: string[];
  script?: ScriptAction[];
  /** Boot budget ms. A spent budget is a note, not a crash (Genex discipline). */
  bootMs?: number;
}

export interface PixelStats {
  width: number;
  height: number;
  lumaMean: number;
  lumaStdDev: number;
  /** Fraction of pixels with luma < 8 (effectively black). */
  nearBlackFraction: number;
  /** Fraction of pixels with luma >= 32 (visibly lit). */
  litFraction: number;
}

export interface ShotEvidence {
  camera: string;
  png: Buffer;
  stats: PixelStats;
}

export interface StateSnapshot {
  atAction: number;
  stateJson: string;
}

export interface EvidenceReport {
  seed: number;
  shots: ShotEvidence[];
  consoleErrors: ConsoleEntry[];
  failedRequests: FailedRequest[];
  states: StateSnapshot[];
  pageErrors: PageErrorEntry[];
  drawCalls: number;
}

/**
 * Model-free pixel statistics (adapted-from-Genex plugin API 3 observe/still
 * luma analysis). Deterministic blank-output detection without any model.
 */
export function computePixelStats(png: Buffer): PixelStats {
  const img = PNG.sync.read(png);
  const n = img.width * img.height;
  if (n === 0) {
    return {
      width: img.width, height: img.height, lumaMean: 0, lumaStdDev: 0,
      nearBlackFraction: 1, litFraction: 0,
    };
  }
  let sum = 0;
  let sumSq = 0;
  let nearBlack = 0;
  let lit = 0;
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    if (luma < 8) nearBlack += 1;
    if (luma >= 32) lit += 1;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return {
    width: img.width,
    height: img.height,
    lumaMean: mean,
    lumaStdDev: Math.sqrt(variance),
    nearBlackFraction: nearBlack / n,
    litFraction: lit / n,
  };
}

export type EvidenceClassification = 'OK' | 'OBSERVATION_DOWN' | 'BUILD_BROKEN';

/**
 * Classify an evidence failure (adapted-from-Genex `classifyEvidenceFailure`).
 * OBSERVATION_DOWN = the harness couldn't look (page unreachable/crashed) → retry,
 *   NOT charged to the build.
 * BUILD_BROKEN = the page ran but the game is broken (errors, failed assets, blank).
 */
export function classifyEvidenceFailure(input: {
  threw?: unknown;
  pageClosed?: boolean;
  report?: EvidenceReport;
}): EvidenceClassification {
  if (input.threw !== undefined || input.pageClosed) return 'OBSERVATION_DOWN';
  const report = input.report;
  if (!report) return 'OBSERVATION_DOWN';
  if (report.consoleErrors.length > 0) return 'BUILD_BROKEN';
  if (report.failedRequests.length > 0) return 'BUILD_BROKEN';
  if (report.pageErrors.length > 0) return 'BUILD_BROKEN';
  // Blank-output gate (Genex's luma gate: MaxNearBlack 0.85 as advisory).
  if (report.shots.length > 0 && report.shots.every((s) => s.stats.nearBlackFraction > 0.85)) {
    return 'BUILD_BROKEN';
  }
  return 'OK';
}

const READY_EXPR =
  `Boolean(window.__studio && typeof window.__studio.ready === 'function' && window.__studio.ready() !== 'loading')`;
const HAS_STUDIO_EXPR = `Boolean(window.__studio)`;

/** Best-effort evaluate: returns fallback instead of throwing. */
async function tryEvaluate<T>(page: BrowserPageLike, expr: string, fallback: T): Promise<T> {
  try {
    return await page.evaluate<T>(expr);
  } catch {
    return fallback;
  }
}

export async function gatherEvidence(
  options: GatherEvidenceOptions,
): Promise<{ report: EvidenceReport; classification: EvidenceClassification }> {
  const {
    page,
    url,
    seed = 1234,
    cameras = ['default'],
    script = [{ steps: 60, dtMs: 16.666 }],
    bootMs = 15000,
  } = options;

  const consoleErrors: ConsoleEntry[] = [];
  const failedRequests: FailedRequest[] = [];
  page.onConsole((type, text) => {
    if (type === 'error') consoleErrors.push({ type, text: text.slice(0, 2000) });
  });
  page.onRequestFailed((reqUrl, failure) => {
    failedRequests.push({ url: reqUrl.slice(0, 500), failure: failure.slice(0, 500) });
  });

  try {
    await page.goto(url);
  } catch (err) {
    return {
      report: emptyReport(seed),
      classification: classifyEvidenceFailure({ threw: err }),
    };
  }

  try {
    await page.waitForFunction(READY_EXPR, bootMs);
  } catch {
    // Ready budget spent: the page loaded but never reported readiness.
    return {
      report: emptyReport(seed),
      classification: 'BUILD_BROKEN',
    };
  }

  const hasStudio = await tryEvaluate(page, HAS_STUDIO_EXPR, false);
  if (!hasStudio) {
    return { report: emptyReport(seed), classification: 'BUILD_BROKEN' };
  }

  await tryEvaluate(page, `window.__studio.seed(${JSON.stringify(seed)})`, null);

  const states: StateSnapshot[] = [];
  // Baseline snapshot right after seeding, so even a single action yields a
  // before/after pair for the state-changed assertion.
  const baseline = await tryEvaluate(page, `JSON.stringify(window.__studio.state())`, '{}');
  states.push({ atAction: -1, stateJson: baseline });

  for (let a = 0; a < script.length; a++) {
    const action = script[a];
    for (const key of action.keys ?? []) {
      try {
        await page.keyboard.down(key);
      } catch { /* best effort */ }
    }
    for (let s = 0; s < action.steps; s++) {
      await tryEvaluate(page, `window.__studio.step(${JSON.stringify(action.dtMs)})`, null);
    }
    for (const key of action.keys ?? []) {
      try {
        await page.keyboard.up(key);
      } catch { /* best effort */ }
    }
    const stateJson = await tryEvaluate(page, `JSON.stringify(window.__studio.state())`, '{}');
    states.push({ atAction: a, stateJson });
  }

  const shots: ShotEvidence[] = [];
  for (const camera of cameras) {
    await tryEvaluate(page, `window.__studio.capture(${JSON.stringify(camera)})`, null);
    let png: Buffer;
    try {
      png = await page.screenshot();
    } catch (err) {
      return {
        report: emptyReport(seed),
        classification: classifyEvidenceFailure({ threw: err }),
      };
    }
    let stats: PixelStats;
    try {
      stats = computePixelStats(png);
    } catch {
      stats = {
        width: 0, height: 0, lumaMean: 0, lumaStdDev: 0,
        nearBlackFraction: 1, litFraction: 0,
      };
    }
    shots.push({ camera, png, stats });
  }

  const pageErrors = await tryEvaluate<PageErrorEntry[]>(
    page, `window.__studio.errors()`, [],
  );
  const drawCalls = await tryEvaluate<number>(page, `window.__studio.drawCalls()`, -1);

  const report: EvidenceReport = {
    seed, shots, consoleErrors, failedRequests, states, pageErrors, drawCalls,
  };
  return { report, classification: classifyEvidenceFailure({ report }) };
}

function emptyReport(seed: number): EvidenceReport {
  return {
    seed, shots: [], consoleErrors: [], failedRequests: [],
    states: [], pageErrors: [], drawCalls: -1,
  };
}
