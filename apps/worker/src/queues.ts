import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Durable queue names. One queue per job family (§9 of master prompt).
 */
export const QUEUE_NAMES = {
  agentRuns: 'agent-runs',
  builds: 'builds',
  assetGenerations: 'asset-generations',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

export interface QueueSet {
  agentRuns: Queue;
  builds: Queue;
  assetGenerations: Queue;
  maintenance: Queue;
  close(): Promise<void>;
}

/**
 * Create all queues against one shared Redis connection. Callers own the
 * returned `close()` for graceful shutdown.
 */
export function createQueues(redisUrl: string): QueueSet {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const opts = { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS };

  const agentRuns = new Queue(QUEUE_NAMES.agentRuns, opts);
  const builds = new Queue(QUEUE_NAMES.builds, opts);
  const assetGenerations = new Queue(QUEUE_NAMES.assetGenerations, opts);
  const maintenance = new Queue(QUEUE_NAMES.maintenance, opts);

  return {
    agentRuns,
    builds,
    assetGenerations,
    maintenance,
    async close() {
      await Promise.all([
        agentRuns.close(),
        builds.close(),
        assetGenerations.close(),
        maintenance.close(),
      ]);
      connection.disconnect();
    },
  };
}
