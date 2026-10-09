/**
 * evidence tests — pixel statistics on synthetic PNGs (pngjs) and failure
 * classification with mocked BrowserPageLike pages. No Chromium needed.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  computePixelStats,
  classifyEvidenceFailure,
  gatherEvidence,
  type BrowserPageLike,
  type EvidenceReport,
} from './evidence.js';

function makePng(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function mockPage(overrides: Partial<BrowserPageLike> = {}): BrowserPageLike {
  const kb = {
    press: async () => {},
    down: async () => {},
    up: async () => {},
  };
  let tick = 0;
  return {
    goto: async () => {},
    evaluate: async <T>(expr: string): Promise<T> => {
      if (expr.includes('__studio.ready')) return true as T;
      if (expr.includes('Boolean(window.__studio)')) return true as T;
      if (expr.includes('__studio.seed')) return null as T;
      if (expr.includes('__studio.step')) { tick += 1; return null as T; }
      if (expr.includes('__studio.state')) return JSON.stringify({ tick }) as T;
      if (expr.includes('__studio.capture')) return true as T;
      if (expr.includes('__studio.errors')) return [] as T;
      if (expr.includes('__studio.drawCalls')) return 7 as T;
      return null as T;
    },
    screenshot: async () => makePng(2, 2, () => [255, 255, 255]),
    keyboard: kb,
    waitForFunction: async () => {},
    onConsole: () => {},
    onRequestFailed: () => {},
    isClosed: () => false,
    ...overrides,
  };
}

describe('computePixelStats', () => {
  it('2x2 all-black → nearBlackFraction=1, lumaMean=0', () => {
    const stats = computePixelStats(makePng(2, 2, () => [0, 0, 0]));
    expect(stats.width).toBe(2);
    expect(stats.height).toBe(2);
    expect(stats.lumaMean).toBe(0);
    expect(stats.lumaStdDev).toBe(0);
    expect(stats.nearBlackFraction).toBe(1);
    expect(stats.litFraction).toBe(0);
  });

  it('half-white / half-black → litFraction≈0.5, lumaMean≈127.5', () => {
    const stats = computePixelStats(makePng(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255])));
    expect(stats.nearBlackFraction).toBe(0.5);
    expect(stats.litFraction).toBe(0.5);
    expect(stats.lumaMean).toBeCloseTo(127.5, 1);
    expect(stats.lumaStdDev).toBeGreaterThan(0);
  });

  it('mid-gray is neither near-black nor lit', () => {
    const stats = computePixelStats(makePng(1, 1, () => [16, 16, 16]));
    expect(stats.nearBlackFraction).toBe(0); // luma 16 >= 8
    expect(stats.litFraction).toBe(0); // luma 16 < 32
    expect(stats.lumaMean).toBeCloseTo(16, 5);
  });
});

describe('classifyEvidenceFailure', () => {
  const okReport: EvidenceReport = {
    seed: 1, shots: [], consoleErrors: [], failedRequests: [],
    states: [], pageErrors: [], drawCalls: 0,
  };

  it('thrown error or closed page → OBSERVATION_DOWN (retry, not charged)', () => {
    expect(classifyEvidenceFailure({ threw: new Error('net::ERR_CONNECTION_REFUSED') }))
      .toBe('OBSERVATION_DOWN');
    expect(classifyEvidenceFailure({ pageClosed: true })).toBe('OBSERVATION_DOWN');
    expect(classifyEvidenceFailure({})).toBe('OBSERVATION_DOWN'); // no report at all
  });

  it('console errors → BUILD_BROKEN', () => {
    expect(classifyEvidenceFailure({
      report: { ...okReport, consoleErrors: [{ type: 'error', text: 'boom' }] },
    })).toBe('BUILD_BROKEN');
  });

  it('failed requests → BUILD_BROKEN', () => {
    expect(classifyEvidenceFailure({
      report: { ...okReport, failedRequests: [{ url: 'x', failure: '404' }] },
    })).toBe('BUILD_BROKEN');
  });

  it('all near-black shots → BUILD_BROKEN (blank output)', () => {
    const black = makePng(2, 2, () => [0, 0, 0]);
    expect(classifyEvidenceFailure({
      report: {
        ...okReport,
        shots: [{ camera: 'a', png: black, stats: computePixelStats(black) }],
      },
    })).toBe('BUILD_BROKEN');
  });

  it('clean report → OK', () => {
    const white = makePng(2, 2, () => [255, 255, 255]);
    expect(classifyEvidenceFailure({
      report: {
        ...okReport,
        shots: [{ camera: 'a', png: white, stats: computePixelStats(white) }],
      },
    })).toBe('OK');
  });
});

describe('gatherEvidence', () => {
  it('runs the full pass: seed → steps → cameras → state/errors', async () => {
    const seen: string[] = [];
    const page = mockPage({
      evaluate: (async <T>(expr: string): Promise<T> => {
        seen.push(expr);
        if (expr.includes('__studio.state')) return JSON.stringify({ n: seen.length }) as T;
        if (expr.includes('__studio.drawCalls')) return 3 as T;
        if (expr.includes('__studio.errors')) return [] as T;
        if (expr.includes('__studio.ready') || expr.includes('Boolean(window.__studio)')) return true as T;
        return null as T;
      }) as BrowserPageLike['evaluate'],
      screenshot: async () => makePng(2, 2, () => [255, 255, 255]),
    });
    const { report, classification } = await gatherEvidence({
      page,
      url: 'http://127.0.0.1:1/',
      seed: 1234,
      cameras: ['main', 'top'],
      script: [{ steps: 3, dtMs: 16.666, keys: ['ArrowUp'] }],
      bootMs: 1000,
    });
    expect(classification).toBe('OK');
    expect(report.seed).toBe(1234);
    expect(report.shots).toHaveLength(2);
    expect(report.shots[0].camera).toBe('main');
    // Baseline (post-seed) + one snapshot per script action.
    expect(report.states).toHaveLength(2);
    expect(report.states[0].atAction).toBe(-1);
    expect(report.states[1].stateJson).not.toBe(report.states[0].stateJson);
    expect(report.drawCalls).toBe(3);
    expect(seen.some((e) => e.includes('__studio.seed(1234)'))).toBe(true);
    expect(seen.filter((e) => e.includes('__studio.step')).length).toBe(3);
  });

  it('crashed page (goto throws) → OBSERVATION_DOWN with empty report', async () => {
    const page = mockPage({
      goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
    });
    const { report, classification } = await gatherEvidence({ page, url: 'http://x/' });
    expect(classification).toBe('OBSERVATION_DOWN');
    expect(report.shots).toEqual([]);
  });

  it('page that never reports ready → BUILD_BROKEN', async () => {
    const page = mockPage({
      waitForFunction: async () => { throw new Error('timeout'); },
    });
    const { classification } = await gatherEvidence({ page, url: 'http://x/', bootMs: 10 });
    expect(classification).toBe('BUILD_BROKEN');
  });

  it('missing __studio contract → BUILD_BROKEN', async () => {
    const page = mockPage({
      evaluate: (async <T>(expr: string): Promise<T> => {
        if (expr.includes('Boolean(window.__studio)')) return false as T;
        if (expr.includes('__studio.ready')) return true as T;
        return null as T;
      }) as BrowserPageLike['evaluate'],
    });
    const { classification } = await gatherEvidence({ page, url: 'http://x/' });
    expect(classification).toBe('BUILD_BROKEN');
  });
});
