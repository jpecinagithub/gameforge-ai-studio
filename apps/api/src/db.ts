import { Pool } from 'pg';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyUnavailable } from './httpErrors.js';
import { safeMessage } from './redact.js';

export interface DbClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Liveness probe. Never throws. */
  ping(): Promise<boolean>;
  /** Apply pending migrations. Throws on failure. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../infra/db/migrations');

/** Advisory lock id for the migrator (arbitrary, documented). */
const MIGRATOR_LOCK = 727312;

export function createDbClient(): DbClient {
  const connectionString = process.env.DATABASE_URL;
  const pool = connectionString
    ? new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 })
    : null;
  pool?.on('error', (err) => {
    console.error(`[db] idle pool error: ${safeMessage(err.message)}`);
  });

  function requirePool(): Pool {
    if (!pool) {
      throw dependencyUnavailable('Postgres is not configured (DATABASE_URL is not set)');
    }
    return pool;
  }

  return {
    async query<T>(text: string, params: unknown[] = []) {
      const p = requirePool();
      try {
        const res = await p.query(text, params as unknown[]);
        return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
      } catch (err) {
        throw dependencyUnavailable(
          `Postgres query failed: ${safeMessage((err as Error).message)}`,
        );
      }
    },

    async ping(): Promise<boolean> {
      if (!pool) return false;
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },

    async migrate(): Promise<void> {
      const p = requirePool();
      const client = await p.connect();
      try {
        await client.query(`SELECT pg_advisory_lock(${MIGRATOR_LOCK})`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        const applied = new Set(
          (await client.query('SELECT filename FROM schema_migrations')).rows.map(
            (r: { filename: string }) => r.filename,
          ),
        );
        let files: string[];
        try {
          files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
        } catch {
          console.warn(`[db] migrations dir not found: ${MIGRATIONS_DIR} — skipping`);
          return;
        }
        const { readFile } = await import('node:fs/promises');
        for (const file of files) {
          if (applied.has(file)) continue;
          const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
          console.log(`[db] applying migration ${file}`);
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${MIGRATOR_LOCK})`);
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool?.end();
    },
  };
}
