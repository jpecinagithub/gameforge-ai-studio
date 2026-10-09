import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { dependencyUnavailable } from './httpErrors.js';
import { safeMessage } from './redact.js';

export interface QueueClient {
  /** Best-effort availability. Never throws. */
  isAvailable(): Promise<boolean>;
  addRunJob(
    runId: string,
    data: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<void>;
  addBuildJob(
    buildId: string,
    data: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<void>;
  /** Waiting + active counts, or null when unavailable. Never throws. */
  queueDepth(queueName: string): Promise<number | null>;
  close(): Promise<void>;
}

const QUEUE_NAMES = ['agent-runs', 'builds', 'asset-generations', 'maintenance'] as const;

export function createQueueClient(): QueueClient {
  const redisUrl = process.env.REDIS_URL;
  let connection: Redis | null = null;
  let queues: Record<string, Queue> | null = null;
  let lastAvailable: boolean | null = null;
  let lastCheck = 0;

  function ensure(): Record<string, Queue> {
    if (!redisUrl) {
      throw dependencyUnavailable('Redis is not configured (REDIS_URL is not set)');
    }
    if (!queues) {
      connection = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 5000,
      });
      connection.on('error', (err: Error) => {
        console.error(`[queue] redis error: ${safeMessage(err.message)}`);
      });
      queues = Object.fromEntries(
        QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: connection as Redis })]),
      );
    }
    return queues;
  }

  async function add(
    queueName: string,
    name: string,
    data: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<void> {
    try {
      const q = ensure()[queueName];
      await q.add(name, data, {
        ...(opts?.jobId ? { jobId: opts.jobId } : {}),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      throw dependencyUnavailable(`Queue unavailable: ${safeMessage((err as Error).message)}`);
    }
  }

  return {
    async isAvailable(): Promise<boolean> {
      const now = Date.now();
      if (lastAvailable !== null && now - lastCheck < 10000) return lastAvailable;
      lastCheck = now;
      if (!redisUrl) {
        lastAvailable = false;
        return false;
      }
      try {
        const qs = ensure();
        await (qs['agent-runs'] as Queue).waitUntilReady();
        lastAvailable = true;
      } catch {
        lastAvailable = false;
      }
      return lastAvailable as boolean;
    },

    addRunJob: (runId, data, opts) => add('agent-runs', 'run', { runId, ...data }, opts),
    addBuildJob: (buildId, data, opts) => add('builds', 'build', { buildId, ...data }, opts),

    async queueDepth(queueName: string): Promise<number | null> {
      try {
        const q = ensure()[queueName];
        if (!q) return null;
        const [waiting, active, delayed] = await Promise.all([
          q.getWaitingCount(),
          q.getActiveCount(),
          q.getDelayedCount(),
        ]);
        return waiting + active + delayed;
      } catch {
        return null;
      }
    },

    async close(): Promise<void> {
      if (queues) await Promise.all(Object.values(queues).map((q) => q.close()));
      connection?.disconnect();
      queues = null;
      connection = null;
    },
  };
}
