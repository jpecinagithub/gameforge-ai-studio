import type { DbClient } from './db.js';
import type { QueueClient } from './queue.js';
import type { GitRunner } from './git.js';
import type { SseGuard } from './security.js';

/** Lazy interface to @gameforge/model-providers (optional at runtime). */
export interface CloudflareClientLike {
  /** Returns the callable @cf/... model slugs from the account catalog. */
  listModels(): Promise<string[]>;
  /**
   * Optional tool-calling probe (implemented by @gameforge/model-providers).
   * Sends one minimal chat completion with a dummy tool definition — SPENDS
   * NEURONS. Accepts boolean or { supported } for forward compatibility.
   */
  probeToolSupport?(modelId: string): Promise<boolean | { supported: boolean }>;
}

export interface ModelProviders {
  createCloudflareClient(apiToken: string, accountId: string): CloudflareClientLike;
}

export interface ServerDeps {
  db: DbClient;
  queues: QueueClient;
  git: GitRunner;
  storageRoot: string;
  version: string;
  /** Null when the package is not installed — /models/connection-test 501s. */
  modelProviders: ModelProviders | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    gameforge: ServerDeps;
    /** Phase 7: bounds concurrent SSE streams (per-run + global caps). */
    sseGuard: SseGuard;
  }
}
