/**
 * Acceptance scenario harness — Phase 7 (§28).
 *
 * Six end-to-end scenarios (A–F) that exercise REAL code paths:
 * the real build pipeline, the real preview page server, the real
 * export-ZIP module, the real asset upload routes, and the real
 * asset-thumbnail plugin. Boundaries that genuinely need live
 * infrastructure (Chromium, Docker, Postgres, Redis, AI provider credentials) are
 * NOT faked: the checks that need them are recorded as `skip` with
 * an explicit `notRunnableHere` reason, which caps the scenario at
 * `partial`. A scenario is `verified` only when every asserted step
 * really ran.
 *
 * Each scenario is hermetic: it builds its fixtures in a temp dir and
 * cleans up after itself. Scenarios never depend on each other.
 */

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** The three honest outcomes. */
export type ScenarioOutcome = 'verified' | 'partial' | 'failed';

export interface ScenarioCheck {
  /** Stable machine-readable name, e.g. 'preview-serves-entry'. */
  name: string;
  status: 'pass' | 'fail' | 'skip';
  /** What was observed. */
  detail?: string;
  /**
   * Set when the check could not REALLY run in this environment.
   * Any check carrying this caps the scenario outcome at `partial`.
   */
  notRunnableHere?: string;
}

export interface ScenarioReport {
  scenario: ScenarioId;
  title: string;
  outcome: ScenarioOutcome;
  checks: ScenarioCheck[];
  /** Human-readable reasons for a partial/failed outcome. */
  reasons: string[];
}

export interface AcceptanceEnvironment {
  node: string;
  platform: string;
  chromium: 'available' | 'unavailable';
  docker: 'available' | 'unavailable';
  providerCredentials: 'set' | 'unset';
}

export interface AcceptanceRun {
  generatedAt: string;
  environment: AcceptanceEnvironment;
  scenarios: ScenarioReport[];
}

/**
 * Derive the scenario outcome from its checks:
 * - any fail → 'failed'
 * - any skip (for any reason) → 'partial'
 * - all pass → 'verified'
 */
export function deriveOutcome(checks: ScenarioCheck[]): ScenarioOutcome {
  if (checks.some((c) => c.status === 'fail')) return 'failed';
  if (checks.some((c) => c.status === 'skip')) return 'partial';
  return 'verified';
}

export function makeCheck(
  name: string,
  status: ScenarioCheck['status'],
  detail?: string,
  notRunnableHere?: string,
): ScenarioCheck {
  const c: ScenarioCheck = { name, status };
  if (detail !== undefined) c.detail = detail;
  if (notRunnableHere !== undefined) c.notRunnableHere = notRunnableHere;
  return c;
}

export function collectReasons(checks: ScenarioCheck[]): string[] {
  const reasons: string[] = [];
  for (const c of checks) {
    if (c.status === 'fail') {
      reasons.push(`${c.name}: FAILED — ${c.detail ?? 'no detail'}`);
    } else if (c.status === 'skip') {
      reasons.push(
        `${c.name}: skipped — ${c.notRunnableHere ?? c.detail ?? 'no reason given'}`,
      );
    }
  }
  return reasons;
}
