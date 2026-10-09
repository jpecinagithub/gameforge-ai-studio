/**
 * Task DAG for multi-agent orchestration (Phase 4).
 *
 * - Task IDs are DETERMINISTIC: task_<sha1(runId|role|objective)[0..12]>. The
 *   same decomposition of the same run always yields the same IDs, so retries
 *   and replays converge instead of duplicating tasks.
 * - topologicalOrder() validates dependency graphs; cycles throw typed
 *   CYCLIC_DEPENDENCY (never silently dropped).
 * - TaskStore is an interface; the pg implementation lives in the worker
 *   (this package never imports pg).
 */
import { createHash } from 'node:crypto';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import type { AgentRole } from './roles.js';
import { StopCode } from '@gameforge/shared';

export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export interface AgentTask {
  id: string;
  runId: string;
  role: AgentRole;
  objective: string;
  dependsOn: string[];
  status: TaskStatus;
  output?: unknown;
}

/** Deterministic task ID: sha1(runId|role|objective), first 12 hex chars. */
export function taskIdFor(runId: string, role: string, objective: string): string {
  const h = createHash('sha1')
    .update(`${runId}|${role}|${objective}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `task_${h}`;
}

export function createTask(
  runId: string,
  role: AgentRole,
  objective: string,
  dependsOn: string[] = [],
): AgentTask {
  return {
    id: taskIdFor(runId, role, objective),
    runId,
    role,
    objective,
    dependsOn: [...dependsOn],
    status: 'queued',
  };
}

/**
 * Kahn's topological sort. Returns tasks in dependency order (dependencies
 * before dependents). Throws typed CYCLIC_DEPENDENCY when the graph has a
 * cycle, and TOOL_VALIDATION_FAILED when a task depends on an unknown id.
 */
export function topologicalOrder(tasks: AgentTask[]): AgentTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
          `Task ${t.id} depends on unknown task ${dep}`,
          StopCode.TOOL_PERMISSION_DENIED,
          { taskId: t.id, dep },
        );
      }
      if (dep === t.id) {
        throw new AgentCoreError(
          AgentCoreErrorCode.CYCLIC_DEPENDENCY,
          `Task ${t.id} depends on itself`,
          StopCode.INTERRUPTED,
          { taskId: t.id },
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, t.dependsOn.length);
    for (const dep of t.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(t.id);
      dependents.set(dep, list);
    }
  }

  // Stable order: process ready tasks in input order.
  const ready = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  const order: AgentTask[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    order.push(task);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t)).map((t) => t.id);
    throw new AgentCoreError(
      AgentCoreErrorCode.CYCLIC_DEPENDENCY,
      `Task dependency cycle detected among: ${stuck.join(', ')}`,
      StopCode.INTERRUPTED,
      { stuck },
    );
  }
  return order;
}

/** Persistence boundary. The worker implements this against Postgres. */
export interface TaskStore {
  create(task: AgentTask): Promise<void>;
  setStatus(id: string, status: TaskStatus, output?: unknown): Promise<void>;
  get(id: string): Promise<AgentTask | null>;
  list(runId: string): Promise<AgentTask[]>;
}

/** In-memory TaskStore for tests and single-process use. */
export function createMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, AgentTask>();
  return {
    async create(task) {
      tasks.set(task.id, { ...task });
    },
    async setStatus(id, status, output) {
      const t = tasks.get(id);
      if (!t) throw new Error(`task not found: ${id}`);
      tasks.set(id, { ...t, status, output: output ?? t.output });
    },
    async get(id) {
      const t = tasks.get(id);
      return t ? { ...t } : null;
    },
    async list(runId) {
      return [...tasks.values()]
        .filter((t) => t.runId === runId)
        .map((t) => ({ ...t }));
    },
  };
}
