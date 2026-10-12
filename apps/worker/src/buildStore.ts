import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildStore, BuildRecord } from '@gameforge/test-runner';
import type { DbPool } from './db.js';

/**
 * PostgreSQL-backed BuildStore (§11, §22).
 *
 * - build_jobs rows are created by the API; the pipeline only updates them.
 * - Artifacts are written to content-addressed storage under
 *   STORAGE_ROOT/artifacts/<buildId>/<name>, with metadata in build_artifacts.
 */
export function createPgBuildStore(pool: DbPool, storageRoot: string): BuildStore {
  const artifactRoot = path.join(storageRoot, 'artifacts');

  return {
    async saveBuildJob(rec: BuildRecord): Promise<void> {
      const result = await pool.query(
        `UPDATE build_jobs SET
           revision_sha = $2,
           status = $3,
           build_dir = $4,
           started_at = COALESCE(started_at, $5),
           ended_at = $6,
           verdict = $7
         WHERE id = $1`,
        [
          rec.buildId,
          rec.revision,
          rec.status,
          `scratch/${rec.buildId}`,
          rec.startedAt,
          rec.endedAt ?? null,
          rec.verdictNotes ? JSON.stringify({ notes: rec.verdictNotes }) : null,
        ],
      );
      if (result.rowCount === 0) throw new Error(`build row missing: ${rec.buildId}`);
    },

    async saveTestResult(buildId, r): Promise<void> {
      await pool.query(
        `INSERT INTO test_results (build_id, suite, name, status, duration_ms, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [buildId, r.suite, r.name, r.status, r.durationMs, JSON.stringify(r.details ?? {})],
      );
    },

    async saveReviewResult(buildId, r): Promise<void> {
      await pool.query(
        `INSERT INTO review_results
           (build_id, criterion, result, confidence, evidence, issue, recommendation, retest_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          buildId,
          r.criterion,
          r.result,
          r.confidence ?? null,
          JSON.stringify(r.evidence ?? {}),
          r.issue ?? null,
          r.recommendation ?? null,
          r.retestRequired ?? false,
        ],
      );
    },

    async saveArtifact(buildId, a): Promise<string> {
      const hash = createHash('sha256').update(a.data).digest('hex');
      const dir = path.join(artifactRoot, buildId);
      mkdirSync(dir, { recursive: true });
      const relPath = a.name.replace(/\\/g, '/').replace(/^\/+/, '');
      const parts = relPath.split('/');
      if (!relPath || parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`unsafe artifact path: ${a.name}`);
      }
      const abs = path.resolve(dir, ...parts);
      if (abs !== dir && !abs.startsWith(dir + path.sep)) {
        throw new Error(`artifact path escapes build root: ${a.name}`);
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, a.data);
      const res = await pool.query(
        `INSERT INTO build_artifacts (build_id, kind, path, size_bytes, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [buildId, a.kind, relPath, a.data.length, hash, JSON.stringify(a.metadata ?? {})],
      );
      return (res.rows[0] as { id: string }).id;
    },
  };
}
