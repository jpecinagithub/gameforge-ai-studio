import { createHash } from 'node:crypto';
import type { AgentTask, TaskStatus, TaskStore } from '@gameforge/agent-core';
import type { DbPool } from './db.js';

/**
 * PostgreSQL TaskStore for the multi-agent orchestrator.
 *
 * ID mapping: the orchestrator uses deterministic string IDs (`task_<hex>`),
 * but agent_tasks.id is a uuid column. The mapping is a stable hash
 * (sha1-based, version/variant bits set — deterministic, not reversible), and
 * the original task ID is stashed in input._taskId so reads round-trip
 * exactly. agent_events.task_id keeps working because it references the uuid.
 */

function stableUuid(name: string): string {
  const h = createHash('sha1').update(`gameforge-task:${name}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // variant 10
  const hex = h.subarray(0, 16).toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

interface TaskRow {
  id: string;
  run_id: string;
  agent_role: string;
  status: string;
  input: Record<string, unknown> | null;
  output: unknown;
}

function rowToTask(row: TaskRow): AgentTask {
  const input = row.input ?? {};
  return {
    id: typeof input['_taskId'] === 'string' ? (input['_taskId'] as string) : row.id,
    runId: row.run_id,
    role: row.agent_role as AgentTask['role'],
    objective: typeof input['objective'] === 'string' ? (input['objective'] as string) : '',
    dependsOn: Array.isArray(input['dependsOn'])
      ? (input['dependsOn'] as string[])
      : [],
    status: row.status as TaskStatus,
    output: row.output ?? undefined,
  };
}

export function createPgTaskStore(pool: DbPool): TaskStore {
  return {
    async create(task: AgentTask): Promise<void> {
      await pool.query(
        `INSERT INTO agent_tasks (id, run_id, agent_role, status, input, output)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          stableUuid(task.id),
          task.runId,
          task.role,
          task.status,
          JSON.stringify({
            _taskId: task.id,
            objective: task.objective,
            dependsOn: task.dependsOn,
          }),
          JSON.stringify(task.output ?? null),
        ],
      );
    },

    async setStatus(id: string, status: TaskStatus, output?: unknown): Promise<void> {
      if (output !== undefined) {
        await pool.query(
          `UPDATE agent_tasks SET status = $2, output = $3,
             started_at = COALESCE(started_at, CASE WHEN $2 = 'running' THEN now() END),
             ended_at = CASE WHEN $2 IN ('completed','failed','canceled') THEN now() ELSE ended_at END
           WHERE id = $1`,
          [stableUuid(id), status, JSON.stringify(output)],
        );
      } else {
        await pool.query(
          `UPDATE agent_tasks SET status = $2,
             started_at = COALESCE(started_at, CASE WHEN $2 = 'running' THEN now() END),
             ended_at = CASE WHEN $2 IN ('completed','failed','canceled') THEN now() ELSE ended_at END
           WHERE id = $1`,
          [stableUuid(id), status],
        );
      }
    },

    async get(id: string): Promise<AgentTask | null> {
      const res = await pool.query(
        `SELECT id, run_id, agent_role, status, input, output FROM agent_tasks WHERE id = $1`,
        [stableUuid(id)],
      );
      const row = res.rows[0] as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    async list(runId: string): Promise<AgentTask[]> {
      const res = await pool.query(
        `SELECT id, run_id, agent_role, status, input, output FROM agent_tasks
         WHERE run_id = $1 ORDER BY created_at ASC`,
        [runId],
      );
      return (res.rows as TaskRow[]).map(rowToTask);
    },
  };
}
