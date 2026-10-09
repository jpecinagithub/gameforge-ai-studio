import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  AgentEventKind,
  BuildStatus,
  type SecretRedactor,
} from '@gameforge/shared';
import {
  runBuildPipeline,
  type AcceptanceCriterion,
  type RunnerLike,
} from '@gameforge/test-runner';
import { runJob, IMAGE_ALLOWLIST, type Capability } from 'gameforge-runner';
import type { DbPool } from './db.js';
import { appendEvent } from './events.js';
import { createPgBuildStore } from './buildStore.js';
import { createBrowser } from './browser.js';
import {
  GroqClient,
  ModelRegistry,
  computeCost,
} from '@gameforge/model-providers';
import type { VisualReviewDeps } from '@gameforge/test-runner';

/**
 * Builds-queue processor — runs the 15-phase build pipeline (§11) inside
 * isolated containers, persists everything to Postgres, and maintains
 * projects.last_good_build_id (a failed build never blanks the last good one).
 */

export interface BuildJobData {
  buildId: string;
  projectId: string;
  revisionSha: string;
}

export interface JobLike {
  data: BuildJobData;
}

export interface BuildProcessorDeps {
  pool: DbPool;
  redactor: Pick<SecretRedactor, 'redactDeep'>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  storageRoot: string;
  /**
   * LLM wiring for the semantic visual review phase. Null when GROQ_API_KEY
   * is not configured — the phase then skips honestly (review labeled
   * unverified) and deterministic checks continue.
   */
  groq?: GroqClient | null;
  registry?: ModelRegistry | null;
}

const TERMINAL_BUILD = new Set<string>([
  BuildStatus.VERIFIED,
  BuildStatus.PARTIAL,
  BuildStatus.FAILED,
  BuildStatus.CANCELED,
]);

/** RunnerLike backed by the container spawn gate. No host exec, ever. */
function createContainerRunner(): RunnerLike {
  let counter = 0;
  const capFor = (c: 'install' | 'build' | 'test' | 'typecheck'): Capability =>
    c === 'typecheck' ? 'build' : c;
  return {
    async exec(opts) {
      const capability = capFor(opts.capability);
      const image = IMAGE_ALLOWLIST[capability]?.[0];
      if (!image) throw new Error(`no image allowlisted for capability ${capability}`);
      const result = await runJob({
        jobId: `bexec-${counter++}`,
        image,
        command: opts.command,
        workdirHostPath: opts.cwd,
        env: opts.env ?? {},
        cpuQuota: 2,
        memMb: 2048,
        pidsLimit: 512,
        timeoutMs: opts.timeoutMs,
        network: opts.network ?? 'none',
        capability,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  };
}

const DEFAULT_CRITERIA: AcceptanceCriterion[] = [
  { id: 'console-clean', description: 'No console errors during boot', check: 'console-clean' },
  { id: 'no-failed-requests', description: 'No failed network requests', check: 'no-failed-requests' },
  { id: 'non-blank', description: 'Rendered output is not blank', check: 'non-blank' },
  { id: 'state-changed', description: 'Scripted inputs change game state', check: 'state-changed' },
];

function gitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

export async function processBuild(
  job: JobLike,
  deps: BuildProcessorDeps,
): Promise<{ outcome: 'noop' | 'completed' | 'failed' }> {
  const { pool, redactor, log, storageRoot } = deps;
  const { buildId, projectId, revisionSha } = job.data;
  const logF = (msg: string, fields?: Record<string, unknown>) =>
    log(msg, { buildId, projectId, ...fields });

  const res = await pool.query(
    `SELECT status, run_id FROM build_jobs WHERE id = $1`,
    [buildId],
  );
  const row = res.rows[0] as { status: string; run_id: string | null } | undefined;
  if (!row) {
    logF('build row missing; no-op');
    return { outcome: 'noop' };
  }
  if (TERMINAL_BUILD.has(row.status)) {
    logF('terminal build; no-op', { status: row.status });
    return { outcome: 'noop' };
  }
  const runId = row.run_id;

  const projectDir = path.join(storageRoot, 'projects', projectId, 'repo');
  const store = createPgBuildStore(pool, storageRoot);

  // Semantic visual review deps: only when a live Groq binding exists.
  // Every LLM completion is recorded in model_usage (§7 cost accounting).
  const vision: VisualReviewDeps | undefined =
    deps.groq && deps.registry
      ? {
          registry: deps.registry,
          client: deps.groq,
          role: 'vision',
          onUsage: async (u) => {
            await pool.query(
              `INSERT INTO model_usage
                 (run_id, agent_role, model_id, input_tokens, output_tokens, cost_usd, latency_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                runId,
                u.role,
                u.modelId,
                u.inputTokens,
                u.outputTokens,
                computeCost(u.modelId, u.inputTokens, u.outputTokens),
                u.latencyMs,
              ],
            );
          },
        }
      : undefined;

  const markBuilding = async () => {
    await pool.query(
      `UPDATE build_jobs SET status = 'building', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'queued'`,
      [buildId],
    );
  };
  const noteRun = async (kind: string, payload: Record<string, unknown>) => {
    if (runId) await appendEvent(pool, redactor, runId, kind as AgentEventKind, payload);
  };

  try {
    await markBuilding();
    await noteRun(AgentEventKind.BUILD_STARTED, { buildId, revisionSha });

    const result = await runBuildPipeline({
      projectDir,
      buildId,
      revision: revisionSha,
      runner: createContainerRunner(),
      browser: await createBrowser(),
      store,
      criteria: DEFAULT_CRITERIA,
      vision,
    });

    const verdict = result.verdict;
    await pool.query(
      `UPDATE build_jobs SET status = $2, ended_at = now(),
         verdict = $3 WHERE id = $1`,
      [
        buildId,
        verdict,
        JSON.stringify({
          phases: result.results.map((r) => ({ name: r.name, status: r.status, error: r.error ?? null })),
        }),
      ],
    );

    if (verdict === BuildStatus.VERIFIED || verdict === BuildStatus.PARTIAL) {
      const head = await gitHead(projectDir);
      await pool.query(
        `UPDATE projects SET last_good_build_id = $2,
           current_revision_id = COALESCE($3, current_revision_id)
         WHERE id = $1`,
        [projectId, buildId, head],
      );
      // Phase 5: record a healthy revision for the revision history UI.
      if (head) {
        await pool.query(
          `INSERT INTO project_revisions
             (project_id, git_sha, message, author_kind, run_id, checkpoint_kind, healthy)
           VALUES ($1, $2, $3, 'system', $4, 'land', true)
           ON CONFLICT (project_id, git_sha) DO UPDATE SET healthy = true`,
          [projectId, head, `build ${buildId} ${verdict}`, runId],
        );
      }
      logF('build passed; last_good updated', { verdict });
    } else {
      logF('build did not pass; last_good untouched', { verdict });
    }

    await noteRun(AgentEventKind.BUILD_FINISHED, { buildId, verdict });
    return { outcome: verdict === BuildStatus.FAILED ? 'failed' : 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE build_jobs SET status = 'failed', ended_at = now(),
         verdict = $2 WHERE id = $1 AND status NOT IN ('verified','partial','failed','canceled')`,
      [buildId, JSON.stringify({ error: message })],
    );
    await noteRun(AgentEventKind.ERROR, { buildId, code: 'build_failed', detail: message });
    logF('build processor threw', { error: message });
    // Re-throw so BullMQ retries with backoff; the row already records the failure.
    throw err;
  }
}
