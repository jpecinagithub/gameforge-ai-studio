import type { AgentEventKind, SecretRedactor } from '@gameforge/shared';
import type { DbPool } from './db.js';

/**
 * Append-only event log writer with redaction-on-append (Genex discipline,
 * adapted). The payload is deep-redacted BEFORE the INSERT — secrets never
 * reach the database, logs, prompts or SSE replays.
 *
 * Sequence allocation is serialized per run: we take a row lock on the
 * agent_runs row inside a transaction, so two concurrent writers for the same
 * run can never mint the same seq.
 */
export async function appendEvent(
  pool: DbPool,
  redactor: Pick<SecretRedactor, 'redactDeep'>,
  runId: string,
  kind: AgentEventKind,
  payload: unknown,
  taskId?: string,
): Promise<{ seq: number }> {
  const safePayload = redactor.redactDeep(payload ?? {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize seq allocation per run.
    await client.query('SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE', [runId]);
    const { rows } = await client.query(
      'SELECT COALESCE(MAX(seq), 0) AS max FROM agent_events WHERE run_id = $1',
      [runId],
    );
    const seq = Number((rows[0] as { max: string | null } | undefined)?.max ?? 0) + 1;
    await client.query(
      'INSERT INTO agent_events (run_id, task_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5)',
      [runId, taskId ?? null, seq, kind, JSON.stringify(safePayload)],
    );
    await client.query('COMMIT');
    return { seq };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best effort; original error is what matters
    }
    throw err;
  } finally {
    client.release();
  }
}
