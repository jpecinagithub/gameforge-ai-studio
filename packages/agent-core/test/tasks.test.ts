/**
 * Task DAG tests (Phase 4).
 *
 * - Deterministic IDs: same inputs → same ID (resume/replay converge).
 * - topologicalOrder: diamond DAG orders dependencies first.
 * - Cycles (incl. self-deps) → typed CYCLIC_DEPENDENCY.
 * - Unknown dependency → typed validation error.
 * - Memory TaskStore round-trips.
 */
import { describe, expect, it } from 'vitest';
import { AgentCoreError, AgentCoreErrorCode } from '../src/errors.js';
import {
  createMemoryTaskStore,
  createTask,
  taskIdFor,
  topologicalOrder,
  type AgentTask,
} from '../src/tasks.js';

function t(id: string, dependsOn: string[] = []): AgentTask {
  return {
    id,
    runId: 'run_1',
    role: 'gameplay',
    objective: `objective ${id}`,
    dependsOn,
    status: 'queued',
  };
}

describe('taskIdFor', () => {
  it('is deterministic and sensitive to each input', () => {
    const a = taskIdFor('run1', 'gameplay', 'build player');
    expect(taskIdFor('run1', 'gameplay', 'build player')).toBe(a);
    expect(a).toMatch(/^task_[0-9a-f]{12}$/);
    expect(taskIdFor('run2', 'gameplay', 'build player')).not.toBe(a);
    expect(taskIdFor('run1', 'ui', 'build player')).not.toBe(a);
    expect(taskIdFor('run1', 'gameplay', 'build enemy')).not.toBe(a);
  });

  it('createTask derives the same id', () => {
    const task = createTask('run1', 'gameplay', 'build player', ['task_x']);
    expect(task.id).toBe(taskIdFor('run1', 'gameplay', 'build player'));
    expect(task.dependsOn).toEqual(['task_x']);
    expect(task.status).toBe('queued');
  });
});

describe('topologicalOrder', () => {
  it('orders a diamond DAG dependencies-first', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const tasks = [t('D', ['B', 'C']), t('C', ['A']), t('B', ['A']), t('A')];
    const order = topologicalOrder(tasks).map((x) => x.id);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    expect(order).toHaveLength(4);
  });

  it('handles independent tasks and empty input', () => {
    expect(topologicalOrder([])).toEqual([]);
    const order = topologicalOrder([t('A'), t('B')]).map((x) => x.id);
    expect(order).toEqual(['A', 'B']); // stable input order
  });

  it('throws typed CYCLIC_DEPENDENCY on a cycle', () => {
    const tasks = [t('A', ['C']), t('B', ['A']), t('C', ['B'])];
    let err: unknown;
    try {
      topologicalOrder(tasks);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.CYCLIC_DEPENDENCY);
  });

  it('throws CYCLIC_DEPENDENCY on a self-dependency', () => {
    let err: unknown;
    try {
      topologicalOrder([t('A', ['A'])]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.CYCLIC_DEPENDENCY);
  });

  it('throws typed validation error on an unknown dependency', () => {
    let err: unknown;
    try {
      topologicalOrder([t('A', ['ghost'])]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
    );
  });
});

describe('createMemoryTaskStore', () => {
  it('round-trips create/get/setStatus/list', async () => {
    const store = createMemoryTaskStore();
    const task = createTask('run1', 'gameplay', 'build player');
    await store.create(task);
    expect((await store.get(task.id))?.status).toBe('queued');
    await store.setStatus(task.id, 'completed', { summary: 'done' });
    const got = await store.get(task.id);
    expect(got?.status).toBe('completed');
    expect((got?.output as { summary: string }).summary).toBe('done');
    expect(await store.get('task_missing')).toBeNull();
    const listed = await store.list('run1');
    expect(listed).toHaveLength(1);
    expect(await store.list('run_other')).toHaveLength(0);
  });
});
