import path from 'node:path';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import {
  BuildStatus,
  createSecretRedactor,
  newBuildId,
} from '@gameforge/shared';
import { CloudflareClient, AlibabaClient, ModelRegistry } from '@gameforge/model-providers';
import type { EvidenceProvider } from '@gameforge/agent-core';
import { createQueues, QUEUE_NAMES } from './queues.js';
import { processAgentRun, type DirectorQueues } from './runProcessor.js';
import { processBuild } from './buildProcessor.js';
import type { DbPool } from './db.js';

/**
 * gameforge-worker — BullMQ worker host.
 *
 * - agent-runs queue → processAgentRun (director turn, tools, builds, evidence)
 * - builds queue → processBuild (15-phase pipeline in containers)
 * Graceful shutdown on SIGTERM/SIGINT.
 */

function jsonLog(level: string, msg: string, fields: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

const log = (msg: string, fields?: Record<string, unknown>) =>
  jsonLog('info', msg, fields);

async function main() {
  const redisUrl = process.env['REDIS_URL'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!redisUrl || !databaseUrl) {
    jsonLog('fatal', 'REDIS_URL and DATABASE_URL are required');
    process.exit(1);
  }
  const storageRoot =
    process.env['STORAGE_ROOT'] ?? path.join(process.cwd(), 'storage');
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? 2);
  const buildConcurrency = Number(process.env['BUILD_CONCURRENCY'] ?? 1);

  // Secrets: register known values so redaction-on-append catches them.
  const redactor = createSecretRedactor();
  if (process.env['CLOUDFLARE_API_TOKEN'])
    redactor.addSecret('cloudflare-token', process.env['CLOUDFLARE_API_TOKEN']);
  if (process.env['DATABASE_URL']) redactor.addSecret('db-url', process.env['DATABASE_URL']);

  const pgPool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const toLike = (r: pg.QueryResult) => ({
    rows: r.rows as unknown[],
    rowCount: r.rowCount ?? 0,
  });
  const pool: DbPool = {
    query: (text, params) => pgPool.query(text, params as unknown[]).then(toLike),
    connect: async () => {
      const client = await pgPool.connect();
      return {
        query: (t, p) => client.query(t, p as unknown[]).then(toLike),
        release: () => client.release(),
      };
    },
    end: () => pgPool.end(),
  };

  // LLM wiring. Alibaba takes priority when ALIBABA_API_KEY is set (Jon has 1M
  // free tokens per model). Otherwise falls back to Cloudflare. No key →
  // the director fails closed with a typed error (processAgentRun), never a fake run.
  // Note: AlibabaClient is structurally compatible with CloudflareClient for
  // the chatCompletions interface used by the agent.
  const provider: CloudflareClient | AlibabaClient | null =
    process.env['ALIBABA_API_KEY']
      ? (new AlibabaClient({ apiKey: process.env['ALIBABA_API_KEY'] }) as unknown as CloudflareClient)
      : process.env['CLOUDFLARE_API_TOKEN'] && process.env['CLOUDFLARE_ACCOUNT_ID']
        ? new CloudflareClient({
            apiToken: process.env['CLOUDFLARE_API_TOKEN'],
            accountId: process.env['CLOUDFLARE_ACCOUNT_ID'],
          })
        : null;
  if (!provider)
    jsonLog('warn', 'No LLM provider configured; agent runs will fail closed');
  else if (process.env['ALIBABA_API_KEY'])
    jsonLog('info', 'Using Alibaba Model Studio as LLM provider');
  const registry = new ModelRegistry();
  if (provider && !process.env['ALIBABA_API_KEY']) {
    try {
      await registry.refresh(provider as CloudflareClient);
      jsonLog('info', 'model registry refreshed from Cloudflare Workers AI');
    } catch (err) {
      jsonLog('warn', 'model registry refresh failed; curated table remains', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const queues = createQueues(redisUrl);
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  // Queue adapter for the director (enqueueBuild/getBuildStatus).
  const directorQueues: DirectorQueues = {
    enqueueBuild: async (projectId, runId, revisionSha) => {
      const buildId = newBuildId();
      await pool.query(
        `INSERT INTO build_jobs (id, project_id, run_id, revision_sha, status, build_dir)
         VALUES ($1,$2,$3,$4,'queued',$5)`,
        [buildId, projectId, runId, revisionSha, `scratch/${projectId}-${buildId}`],
      );
      await queues.builds.add('build', { buildId, projectId, revisionSha }, { jobId: buildId });
      return { buildId };
    },
    getBuildStatus: async (buildId: string) => {
      const res = await pool.query(
        `SELECT status, verdict FROM build_jobs WHERE id = $1`,
        [buildId],
      );
      const brow = res.rows[0] as { status: string; verdict: unknown } | undefined;
      if (!brow) throw new Error(`build ${buildId} not found`);
      return { status: brow.status as BuildStatus, verdict: brow.verdict };
    },
  };

  // Evidence summary for the director: what the pipeline already persisted.
  const evidence: EvidenceProvider = {
    gather: async (buildId: string) => {
      const [artsRes, revsRes] = await Promise.all([
        pool.query(`SELECT kind FROM build_artifacts WHERE build_id = $1`, [buildId]),
        pool.query(
          `SELECT criterion, result FROM review_results WHERE build_id = $1`,
          [buildId],
        ),
      ]);
      const arts = artsRes.rows as Array<{ kind: string }>;
      const revs = revsRes.rows as Array<{ criterion: string; result: string }>;
      const screenshots = arts.filter((a) => a.kind === 'screenshot').length;
      const blankDetected = revs.some((r) => r.criterion === 'non-blank' && r.result === 'fail');
      return {
        buildId,
        screenshots,
        consoleErrors: 0,
        blankDetected,
        notes: revs.map((r) => `${r.criterion}: ${r.result}`),
      };
    },
  };

  const agentRunsWorker = new Worker(
    QUEUE_NAMES.agentRuns,
    async (job) =>
      processAgentRun(job, {
        pool,
        redactor,
        log,
        storageRoot,
        provider,
        registry,
        queues: directorQueues,
        evidence,
      }),
    { connection, concurrency },
  );
  agentRunsWorker.on('failed', (job, err) =>
    jsonLog('error', 'agent-run job failed', { jobId: job?.id, error: err.message }),
  );

  const buildsWorker = new Worker(
    QUEUE_NAMES.builds,
    async (job) => processBuild(job, { pool, redactor, log, storageRoot, provider, registry }),
    { connection, concurrency: buildConcurrency },
  );
  buildsWorker.on('failed', (job, err) =>
    jsonLog('error', 'build job failed', { jobId: job?.id, error: err.message }),
  );

  const shutdown = async (signal: string) => {
    jsonLog('info', `received ${signal}; draining workers`);
    await Promise.all([agentRunsWorker.close(), buildsWorker.close()]);
    await queues.close();
    connection.disconnect();
    await pool.end();
    jsonLog('info', 'shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  jsonLog('info', 'gameforge-worker started', {
    concurrency,
    buildConcurrency,
    provider: provider ? 'configured' : 'missing',
  });
}

void main();
