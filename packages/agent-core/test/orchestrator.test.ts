/**
 * Orchestrator tests (Phase 4) — scripted provider, real temp git repos.
 *
 * - dispatchTask tool: no dispatcher → typed failure; bad role → validation
 *   error; delegates when a dispatcher is present.
 * - Role tool restriction: reviewer calling writeFile → unknown_tool, no file.
 * - Gameplay writeFile in a worktree merges into the main checkout.
 * - Dependency gate: unmet dependsOn → DEPENDENCY_FAILED; met → runs.
 * - Bounded correction: 3 fix rounds max, then stops.
 * - Loop mode: stops with NO_MEASURABLE_PROGRESS when verdicts stall.
 * - Manual mode: approval gate raises PauseForUser.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BuildStatus,
  StopCode,
  createSecretRedactor,
} from '@gameforge/shared';
import {
  BudgetTracker,
  type ChatCompletionsResult,
  type CloudflareClient,
  type ModelRegistry,
  type ToolCall,
} from '@gameforge/model-providers';
import { runMultiAgentJob } from '../src/orchestrator.js';
import { createMemoryTaskStore } from '../src/tasks.js';
import {
  AgentCoreError,
  AgentCoreErrorCode,
  isPauseForUser,
} from '../src/errors.js';
import {
  executeToolCall,
  type ToolContext,
} from '../src/tools.js';
import type { MemoryStore } from '../src/memory.js';
import type { DbLike, QueuesLike } from '../src/jobIntegration.js';

const SHA = 'd'.repeat(40);

/* ---------- scripted provider ---------- */

type ScriptStep =
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, unknown> }>; text?: string }
  | { kind: 'text'; text: string };

function scriptedProvider(steps: ScriptStep[]): CloudflareClient {
  const queue = [...steps];
  return {
    chatCompletions: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('provider script exhausted — unexpected extra model call');
      const toolCalls: ToolCall[] =
        next.kind === 'tools'
          ? next.calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: c.args }))
          : [];
      const res: ChatCompletionsResult = {
        content: next.kind === 'text' ? next.text : (next.text ?? null),
        toolCalls,
        usage: { inputTokens: 50, outputTokens: 20 },
        model: 'mock-model',
        latencyMs: 5,
      };
      return res;
    }),
  } as unknown as CloudflareClient;
}

const tools = (...calls: Array<{ name: string; args: Record<string, unknown> }>): ScriptStep => ({
  kind: 'tools',
  calls,
});
const text = (t: string): ScriptStep => ({ kind: 'text', text: t });
const finish = (summary: string): ScriptStep =>
  tools({ name: 'finishRun', args: { summary } });

const registry = { selectModel: () => 'mock-model' } as unknown as ModelRegistry;

/* ---------- harness ---------- */

interface Harness {
  workDir: string;
  events: Array<{ kind: string; name: string }>;
  buildsSeen: string[];
  verdicts: BuildStatus[];
  memoryWrites: Array<{ scope: string; key: string }>;
}

function makeMemory(): MemoryStore {
  return {
    write: async () => ({ id: 'm1' }) as never,
    supersede: async () => ({ id: 'm1' }) as never,
    listCurrent: async () => [],
    search: async () => [],
  } as unknown as MemoryStore;
}

async function makeHarness(verdicts: BuildStatus[]): Promise<{
  h: Harness;
  opts: Parameters<typeof runMultiAgentJob>[0];
  providerRef: { provider: CloudflareClient | null };
}> {
  const h: Harness = {
    workDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gf-orch-')),
    events: [],
    buildsSeen: [],
    verdicts: [...verdicts],
    memoryWrites: [],
  };
  let buildN = 0;
  const queues: QueuesLike = {
    enqueueBuild: async () => {
      buildN += 1;
      const buildId = `build_${buildN}`;
      h.buildsSeen.push(buildId);
      return { buildId };
    },
    getBuildStatus: async () => ({
      status: h.verdicts[Math.min(buildN, h.verdicts.length) - 1] ?? BuildStatus.FAILED,
    }),
  };
  const providerRef: { provider: CloudflareClient | null } = { provider: null };
  const opts = {
    runId: 'run_orch_test',
    projectId: 'proj_orch_test',
    db: { query: async () => ({ rows: [] }) } as DbLike,
    queues,
    workDir: h.workDir,
    userRequest: 'Build a tiny game.',
    provider: undefined as unknown as CloudflareClient, // set per-test via providerRef
    registry,
    evidence: {
      gather: async (buildId: string) => ({
        buildId,
        screenshots: 2,
        consoleErrors: 0,
        blankDetected: false,
        notes: [],
      }),
    },
    events: {
      questionAsked: async () => undefined,
      toolCall: async (_r: string, name: string) => {
        h.events.push({ kind: 'call', name });
      },
      toolResult: async (_r: string, name: string) => {
        h.events.push({ kind: 'result', name });
      },
    },
    memory: makeMemory(),
    taskStore: createMemoryTaskStore(),
    buildPollIntervalMs: 1,
    buildTimeoutMs: 5000,
  };
  return { h, opts, providerRef };
}

function withProvider<T extends { provider: CloudflareClient }>(
  base: T,
  provider: CloudflareClient,
): T & { provider: CloudflareClient } {
  return { ...base, provider };
}

/* ---------- tests ---------- */

describe('dispatchTask tool', () => {
  function ctxWith(dispatcher?: ToolContext['dispatcher']): ToolContext {
    return {
      runId: 'r',
      projectId: 'p',
      workDir: '/tmp',
      git: {
        checkpoint: async () => SHA,
        head: async () => SHA,
        status: async () => ({ clean: true, changed: [] }),
        diff: async () => '',
      },
      builds: {
        enqueue: async () => ({ buildId: 'b' }),
        status: async () => ({ status: BuildStatus.VERIFIED }),
      },
      evidence: {
        gather: async (buildId: string) => ({
          buildId,
          screenshots: 0,
          consoleErrors: 0,
          blankDetected: false,
          notes: [],
        }),
      },
      events: {
        questionAsked: async () => undefined,
        toolCall: async () => undefined,
        toolResult: async () => undefined,
      },
      redactor: createSecretRedactor(),
      memory: makeMemory(),
      dispatcher,
    };
  }

  it('fails closed without a dispatcher (single-agent mode)', async () => {
    const err = await executeToolCall(
      'dispatchTask',
      { role: 'gameplay', objective: 'do thing' },
      ctxWith(undefined),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.TOOL_EXECUTION_FAILED);
  });

  it('rejects unknown roles at validation', async () => {
    const err = await executeToolCall(
      'dispatchTask',
      { role: 'janitor', objective: 'do thing' },
      ctxWith(undefined),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
    );
  });

  it('delegates to the dispatcher when present', async () => {
    const dispatch = vi.fn(async () => ({
      taskId: 'task_abc',
      status: 'completed',
      summary: 'did it',
    }));
    const res = (await executeToolCall(
      'dispatchTask',
      { role: 'gameplay', objective: 'do thing', dependsOn: ['task_x'] },
      ctxWith({ dispatch }),
    )) as { taskId: string };
    expect(res.taskId).toBe('task_abc');
    expect(dispatch).toHaveBeenCalledWith('gameplay', 'do thing', ['task_x']);
  });
});

describe('runMultiAgentJob', () => {
  it('reviewer role cannot write files (unknown_tool), gameplay can', async () => {
    // Director dispatches a reviewer task whose script tries writeFile.
    // Queue order matters: director(1) → reviewer(2,3) → director(4).
    const { h, opts } = await makeHarness([BuildStatus.VERIFIED]);
    const provider = scriptedProvider([
      tools({ name: 'dispatchTask', args: { role: 'reviewer', objective: 'review the game' } }),
      // reviewer turn: tries writeFile (denied), then finishRun
      tools({ name: 'writeFile', args: { path: 'evil.txt', content: 'x' } }),
      finish('reviewer done'),
      finish('director done'),
    ]);
    const res = await runMultiAgentJob(withProvider(opts, provider));
    expect(res.buildStatus).toBe(BuildStatus.VERIFIED);
    // The write was denied: no file anywhere.
    await expect(fs.stat(path.join(h.workDir, 'evil.txt'))).rejects.toThrow();
    const tasks = await opts.taskStore.list('run_orch_test');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].role).toBe('reviewer');
    expect(tasks[0].status).toBe('completed');
  });

  it('gameplay writeFile in a worktree merges into the main checkout', async () => {
    const { h, opts } = await makeHarness([BuildStatus.VERIFIED]);
    const provider = scriptedProvider([
      tools({ name: 'dispatchTask', args: { role: 'gameplay', objective: 'add feature file' } }),
      finish('director done'),
      tools({ name: 'writeFile', args: { path: 'feat.txt', content: 'hello\n' } }),
      finish('gameplay done'),
    ]);
    await runMultiAgentJob(withProvider(opts, provider));
    // Merged into the main checkout.
    expect(await fs.readFile(path.join(h.workDir, 'feat.txt'), 'utf8')).toBe('hello\n');
    // No leftover worktree checkouts.
    const wtRoot = path.join(h.workDir, '.studio', 'worktrees');
    const entries = await fs.readdir(wtRoot).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('dependency gate: unmet dependsOn fails typed; met deps run', async () => {
    const { opts } = await makeHarness([BuildStatus.VERIFIED]);
    const provider = scriptedProvider([
      tools(
        { name: 'dispatchTask', args: { role: 'gameplay', objective: 'task A' } },
        // dependsOn a task that was never dispatched → DEPENDENCY_FAILED
        { name: 'dispatchTask', args: { role: 'gameplay', objective: 'task B', dependsOn: ['task_ghost0000'] } },
      ),
      finish('director done'),
      finish('A done'),
    ]);
    await runMultiAgentJob(withProvider(opts, provider));
    const tasks = await opts.taskStore.list('run_orch_test');
    const a = tasks.find((t) => t.objective === 'task A');
    expect(a?.status).toBe('completed');
    // B was never created (dependency check happens before create).
    expect(tasks.find((t) => t.objective === 'task B')).toBeUndefined();
  });

  it('bounded correction: exactly 3 fix rounds, then stops', async () => {
    const { opts } = await makeHarness([
      BuildStatus.FAILED,
      BuildStatus.PARTIAL,
      BuildStatus.VERIFIED,
      BuildStatus.VERIFIED,
    ]);
    const provider = scriptedProvider([
      finish('director done'), // no initial tasks
      // fix #1
      finish('fix1 done'),
      // reviewer #1 → pick B
      text('{"pick": "B", "biggestGap": "gap one", "notes": "n"}'),
      // fix #2
      finish('fix2 done'),
      // reviewer #2 → pick B
      text('{"pick": "B", "biggestGap": "gap two", "notes": "n"}'),
      // fix #3
      finish('fix3 done'),
      // reviewer #3 → pick B (loop exhausted after this)
      text('{"pick": "B", "biggestGap": "gap three", "notes": "n"}'),
    ]);
    const res = await runMultiAgentJob(
      withProvider(
        {
          ...opts,
          incumbentBuildId: 'build_inc',
          maxCorrectionRounds: 3,
        },
        provider,
      ),
    );
    expect(res.buildStatus).toBe(BuildStatus.VERIFIED);
    expect(res.reviews).toHaveLength(3);
    const tasks = await opts.taskStore.list('run_orch_test');
    const fixes = tasks.filter((t) => t.role === 'gameplay');
    expect(fixes).toHaveLength(3);
    expect(fixes.every((t) => t.status === 'completed')).toBe(true);
    // 4 builds total: initial + 3 fix rebuilds.
    expect(res.buildId).toBe('build_4');
  });

  it('correction stops early when the review flips to the candidate', async () => {
    const { opts } = await makeHarness([BuildStatus.FAILED, BuildStatus.VERIFIED]);
    const provider = scriptedProvider([
      finish('director done'),
      finish('fix1 done'),
      text('{"pick": "A", "biggestGap": "none remaining", "notes": "candidate wins"}'),
    ]);
    const res = await runMultiAgentJob(
      withProvider({ ...opts, incumbentBuildId: 'build_inc' }, provider),
    );
    expect(res.buildStatus).toBe(BuildStatus.VERIFIED);
    expect(res.reviews).toHaveLength(1);
    expect(res.reviews[0].pick).toBe('A');
    const tasks = await opts.taskStore.list('run_orch_test');
    expect(tasks.filter((t) => t.role === 'gameplay')).toHaveLength(1);
  });

  it('loop mode stops with NO_MEASURABLE_PROGRESS when verdicts stall', async () => {
    const { opts } = await makeHarness([BuildStatus.VERIFIED, BuildStatus.VERIFIED]);
    const provider = scriptedProvider([
      finish('director done'),
      // improvement turn: dispatch one task, then finish
      tools({ name: 'dispatchTask', args: { role: 'gameplay', objective: 'polish' } }),
      finish('no further improvements'),
      finish('polish done'),
    ]);
    const res = await runMultiAgentJob(
      withProvider({ ...opts, runMode: 'loop', maxLoopIterations: 5 }, provider),
    );
    expect(res.stopCode).toBe(StopCode.NO_MEASURABLE_PROGRESS);
    expect(res.loopIterations).toBe(2);
    expect(res.buildStatus).toBe(BuildStatus.VERIFIED);
  });

  it('director that never calls tools fails the run honestly (DIRECTOR_IDLE)', async () => {
    const { opts } = await makeHarness([BuildStatus.VERIFIED]);
    // 3 text-only responses exhaust the re-prompts; the turn ends with 0 steps.
    const provider = scriptedProvider([
      text('I will think about it.'),
      text('Still thinking.'),
      text('Almost decided.'),
    ]);
    const err = await runMultiAgentJob(withProvider(opts, provider)).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.DIRECTOR_IDLE);
    expect((err as AgentCoreError).stopCode).toBe(StopCode.NO_MEASURABLE_PROGRESS);
  });

  it('manual mode pauses at the approval gate (PauseForUser)', async () => {
    const { opts } = await makeHarness([BuildStatus.VERIFIED]);
    const provider = scriptedProvider([finish('director done')]);
    const err = await runMultiAgentJob(
      withProvider({ ...opts, runMode: 'manual' }, provider),
    ).catch((e) => e);
    expect(isPauseForUser(err)).toBe(true);
  });

  it('skips blind review without an incumbent (note in summary)', async () => {
    const { opts } = await makeHarness([BuildStatus.VERIFIED]);
    const provider = scriptedProvider([finish('director done')]);
    const res = await runMultiAgentJob(withProvider(opts, provider));
    expect(res.reviews).toHaveLength(0);
    expect(res.buildStatus).toBe(BuildStatus.VERIFIED);
  });
});
