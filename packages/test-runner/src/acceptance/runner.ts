/**
 * Runs the full acceptance suite (scenarios A–F) sequentially.
 * Each scenario is hermetic and cleans up after itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF } from './scenarios.js';
import { cleanupTempDirs, chromeBinaryPath } from './fixtures.js';
import type { AcceptanceEnvironment, AcceptanceRun, ScenarioReport } from './types.js';

function detectEnvironment(): AcceptanceEnvironment {
  // A real browser counts as available only when a launchable binary exists —
  // the playwright CLI version alone proves nothing (it needs no binary).
  const chromium: AcceptanceEnvironment['chromium'] =
    chromeBinaryPath() !== null ? 'available' : 'unavailable';
  let docker: AcceptanceEnvironment['docker'] = 'unavailable';
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 15000 });
    docker = 'available';
  } catch {
    docker = 'unavailable';
  }
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    chromium,
    docker,
    providerCredentials: process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? 'set' : 'unset',
  };
}

export async function runAcceptanceSuite(): Promise<AcceptanceRun> {
  const scenarios: ScenarioReport[] = [];
  const fns = [scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF];
  for (const fn of fns) {
    try {
      scenarios.push(await fn());
    } catch (err) {
      // A scenario must never take down the suite: record it as failed.
      const id = fn.name.replace('scenario', '') as ScenarioReport['scenario'];
      scenarios.push({
        scenario: id,
        title: fn.name,
        outcome: 'failed',
        checks: [
          {
            name: 'scenario-threw',
            status: 'fail',
            detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        ],
        reasons: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
      });
    } finally {
      cleanupTempDirs();
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    environment: detectEnvironment(),
    scenarios,
  };
}
