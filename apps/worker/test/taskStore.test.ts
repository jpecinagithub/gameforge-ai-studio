import { describe, expect, it, vi } from 'vitest';
import { createPgTaskStore } from '../src/taskStore.js';
import type { DbPool } from '../src/db.js';
import type { AgentTask } from '@gameforge/agent-core';

function createMockPool(rows: unknown[] = []) {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
  const pool: DbPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    }),
    connect: vi.fn(),
    end: vi.fn(async () => {}),
  };
  return { pool, calls };
}

const task: AgentTask = {
  id: 'task_abc123def456',
  runId: 'run_01',
  role: 'gameplay',
  objective: 'add jumping',
  dependsOn: [],
  status: 'queued',
};

describe('createPgTaskStore', () => {
  it('creates a task with a stable uuid id and stashes the task key', async () => {
    const { pool, calls } = createMockPool();
    const store = createPgTaskStore(pool);
    await store.create(task);
    const insert = calls.find((c) => /INSERT INTO agent_tasks/i.test(c.text));
    expect(insert).toBeDefined();
    const id = insert!.params![0] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const input = JSON.parse(String(insert!.params![4]));
    expect(input._taskId).toBe('task_abc123def456');
    expect(input.objective).toBe('add jumping');
    // Deterministic: same task → same uuid.
    const second = createMockPool();
    const store2 = createPgTaskStore(second.pool);
    await store2.create(task);
    expect(second.calls[0]!.params![0]).toBe(id);
  });

  it('round-trips get() with the original task id', async () => {
    const row = {
      id: 'some-uuid',
      run_id: 'run_01',
      agent_role: 'gameplay',
      status: 'running',
      input: { _taskId: 'task_abc123def456', objective: 'add jumping', dependsOn: [] },
      output: { files: 3 },
    };
    const { pool } = createMockPool([row]);
    const store = createPgTaskStore(pool);
    const got = await store.get('task_abc123def456');
    expect(got?.id).toBe('task_abc123def456');
    expect(got?.role).toBe('gameplay');
    expect(got?.status).toBe('running');
    expect(got?.output).toEqual({ files: 3 });
  });

  it('setStatus updates status and optionally output', async () => {
    const { pool, calls } = createMockPool();
    const store = createPgTaskStore(pool);
    await store.setStatus('task_abc123def456', 'completed', { ok: true });
    const upd = calls.find((c) => /UPDATE agent_tasks SET status/i.test(c.text));
    expect(upd).toBeDefined();
    expect(upd!.params![1]).toBe('completed');
    expect(JSON.parse(String(upd!.params![2]))).toEqual({ ok: true });
  });

  it('list() returns tasks in creation order', async () => {
    const rows = [
      { id: 'u1', run_id: 'run_01', agent_role: 'gameplay', status: 'completed', input: { _taskId: 'task_1', objective: 'a', dependsOn: [] }, output: null },
      { id: 'u2', run_id: 'run_01', agent_role: 'qa', status: 'queued', input: { _taskId: 'task_2', objective: 'b', dependsOn: ['task_1'] }, output: null },
    ];
    const { pool, calls } = createMockPool(rows);
    const store = createPgTaskStore(pool);
    const list = await store.list('run_01');
    expect(list).toHaveLength(2);
    expect(list[1]!.dependsOn).toEqual(['task_1']);
    expect(calls[0]!.params![0]).toBe('run_01');
  });
});
