import { buildServer } from './server.js';
import { createDbClient } from './db.js';
import { createQueueClient } from './queue.js';
import { realGitRunner } from './git.js';
import { initRedaction } from './redact.js';
import { safeMessage } from './redact.js';
import type { ModelProviders } from './types.js';

/** Best-effort dynamic import: the API works without the provider package. */
async function loadModelProviders(): Promise<ModelProviders | null> {
  try {
    return (await import('@gameforge/model-providers')) as unknown as ModelProviders;
  } catch {
    console.warn('[api] @gameforge/model-providers not installed — /models/connection-test will 503');
    return null;
  }
}

async function main(): Promise<void> {
  initRedaction();

  const db = createDbClient();
  const queues = createQueueClient();

  try {
    await db.migrate();
  } catch (err) {
    // Degraded boot: serve health/ready (which will report postgres down) and
    // let DB-backed routes return 503 instead of crashing the process.
    console.error(`[api] migrations failed, continuing degraded: ${safeMessage((err as Error).message)}`);
  }

  const modelProviders = await loadModelProviders();
  const storageRoot = process.env.STORAGE_ROOT ?? '/var/lib/gameforge/storage';

  const server = await buildServer({
    db,
    queues,
    git: realGitRunner,
    storageRoot,
    version: '0.1.0',
    modelProviders,
  });

  const port = Number(process.env.PORT ?? 8090);
  // Default bind is loopback: the reverse proxy terminates TLS. Binding 0.0.0.0
  // requires an explicit BIND_ADDR — never the default.
  const host = process.env.BIND_ADDR ?? '127.0.0.1';
  await server.listen({ port, host });
  console.log(`[api] listening on http://${host}:${port}`);

  // Preview origin (untrusted game content, separate origin per ARCHITECTURE §8).
  // Served by the same process on PREVIEW_PORT; Caddy routes preview.$DOMAIN here.
  const { buildPreviewServer } = await import('./preview.js');
  const previewPort = Number(process.env.PREVIEW_PORT ?? 8091);
  const studioOrigin =
    process.env.STUDIO_ORIGIN ??
    (process.env.GF_DOMAIN ? `https://${process.env.GF_DOMAIN}` : `http://${host}:${port}`);
  const previewServer = buildPreviewServer({
    storageRoot,
    db: {
      query: <T>(t: string, p?: unknown[]) => db.query<T>(t, p),
    },
    studioOrigin,
  });
  await previewServer.listen({ port: previewPort, host });
  console.log(`[api] preview origin on http://${host}:${previewPort}`);

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} — draining`);
    try {
      await server.close();
      await previewServer.close();
    } finally {
      await queues.close();
      await db.close();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[api] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
