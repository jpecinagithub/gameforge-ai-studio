/**
 * Acceptance scenarios A–F (§28).
 *
 * Each test runs its scenario against REAL code paths (pipeline, page
 * server, export module, asset routes, thumbnail plugin). Browser-bound
 * verification is exercised through the faithful stub only — those
 * checks are recorded as `skip` with an explicit `notRunnableHere`
 * reason, capping the scenario at `partial`. Nothing is green-washed:
 * a scenario is `verified` only when every asserted step really ran.
 */
import { describe, it, expect } from 'vitest';
import {
  scenarioA,
  scenarioB,
  scenarioC,
  scenarioD,
  scenarioE,
  scenarioF,
} from './scenarios.js';
import type { ScenarioReport } from './types.js';

const TIMEOUT = 180_000;

function assertWellFormed(r: ScenarioReport) {
  expect(['verified', 'partial', 'failed']).toContain(r.outcome);
  expect(r.checks.length).toBeGreaterThan(0);
  for (const c of r.checks) {
    expect(c.name).toMatch(/^[a-z0-9-]+$/);
    expect(['pass', 'fail', 'skip']).toContain(c.status);
    if (c.status === 'skip') {
      expect(
        c.notRunnableHere,
        `check '${c.name}' is skipped but gives no notRunnableHere reason`,
      ).toBeTruthy();
    }
  }
  // reasons must account for every non-pass check
  const nonPass = r.checks.filter((c) => c.status !== 'pass').length;
  expect(r.reasons.length).toBe(nonPass);
}

function failedChecks(r: ScenarioReport) {
  return r.checks.filter((c) => c.status === 'fail');
}

describe('acceptance scenarios', () => {
  it(
    'A — basic 3D game: builds, previews, exports, real-browser verification',
    async () => {
      const r = await scenarioA();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      // With a real Chromium available this scenario is fully verified;
      // without one it degrades honestly to partial (browser-verification
      // skipped, never faked).
      expect(['verified', 'partial']).toContain(r.outcome);
      const names = r.checks.map((c) => c.name);
      for (const n of ['files-present', 'verdict-recorded', 'preview-serves-entry', 'zip-export', 'zip-reproducible', 'secret-scan-refusal', 'browser-verification']) {
        expect(names).toContain(n);
      }
      const bv = r.checks.find((c) => c.name === 'browser-verification')!;
      if (r.outcome === 'verified') {
        expect(bv.status).toBe('pass');
        expect(bv.detail).toMatch(/real Chromium/);
      } else {
        expect(bv.status).toBe('skip');
        expect(bv.notRunnableHere).toMatch(/chromium/i);
      }
    },
    TIMEOUT,
  );

  it(
    'B — enhancement: rebuild picks up the change, regression green on a real page',
    async () => {
      const r = await scenarioB();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      expect(['verified', 'partial']).toContain(r.outcome);
      const byName = new Map(r.checks.map((c) => [c.name, c]));
      expect(byName.get('change-in-build')?.status).toBe('pass');
      expect(byName.get('both-revisions-recorded')?.status).toBe('pass');
      if (r.outcome === 'verified') {
        expect(byName.get('gameplay-regression')?.status).toBe('pass');
      }
    },
    TIMEOUT,
  );

  it(
    'C — failed build recovery: diagnostics, last-good intact, bounded correction — verified',
    async () => {
      const r = await scenarioC();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      // Every asserted step really ran: no browser-fidelity dependency.
      expect(r.outcome).toBe('verified');
      const byName = new Map(r.checks.map((c) => [c.name, c]));
      for (const n of ['verdict-failed', 'diagnostics-captured', 'diagnostics-persisted', 'failed-job-recorded', 'last-good-intact', 'failed-build-has-no-playable-files', 'last-good-previewable', 'correction-bounded']) {
        expect(byName.get(n)?.status, n).toBe('pass');
      }
    },
    TIMEOUT,
  );

  it(
    'D — interrupted execution: state retained, no duplicate paid ops; real SIGKILL partial',
    async () => {
      const r = await scenarioD();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      expect(r.outcome).toBe('partial');
      const byName = new Map(r.checks.map((c) => [c.name, c]));
      expect(byName.get('no-duplicate-paid-ops')?.status).toBe('pass');
      expect(byName.get('rerun-completes')?.status).toBe('pass');
      expect(byName.get('process-kill-recovery')?.status).toBe('skip');
    },
    TIMEOUT,
  );

  it(
    'E — asset integration: real upload routes + real thumbnail plugin; GLB runtime partial',
    async () => {
      const r = await scenarioE();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      expect(r.outcome).toBe('partial');
      const byName = new Map(r.checks.map((c) => [c.name, c]));
      for (const n of ['upload-201', 'upload-contained', 'upload-integrity', 'download-roundtrip', 'validation-empty', 'thumbnail-real', 'delete-204']) {
        expect(byName.get(n)?.status, n).toBe('pass');
      }
      expect(byName.get('glb-runtime-checks')?.status).toBe('skip');
    },
    TIMEOUT,
  );

  it(
    'F — export: valid reproducible ZIP with source + README, no secrets — verified',
    async () => {
      const r = await scenarioF();
      assertWellFormed(r);
      expect(failedChecks(r)).toEqual([]);
      expect(r.outcome).toBe('verified');
    },
    TIMEOUT,
  );
});
