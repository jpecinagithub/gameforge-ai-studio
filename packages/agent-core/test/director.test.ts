/**
 * Director turn tests with a scripted (mocked) Groq client.
 *
 * - Full scripted run: listFiles → writeFile → execBuild → buildStatus → finishRun.
 * - askUser → PauseForUser propagates; the loop stops immediately (no more calls).
 * - Budget exhaustion mid-loop → typed BudgetExhaustedError, loop halts.
 * - maxRounds exceeded → typed ITERATION_BUDGET_EXHAUSTED.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  BuildStatus,
  createSecretRedactor,
  StopCode,
} from '@gameforge/shared';
import {
  BudgetExhaustedError,
  BudgetTracker,
  type ChatCompletionsResult,
  type GroqClient,
  type ModelRegistry,
  type ToolCall,
} from '@gameforge/model-providers';
import { runDirectorTurn } from '../src/director.js';
import {
  AgentCoreError,
  AgentCoreErrorCode,
  PauseForUser,
  isPauseForUser,
} from '../src/errors.js';
import type { GitOps, ToolContext } from '../src/tools.js';

const SHA = 'c'.repeat(40);

function scriptedGroq(responses: ChatCompletionsResult[]): GroqClient {
  const queue = [...responses];
  return {
    chatCompletions: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('script exhausted — unexpected extra model call');
      return next;
    }),
  } as unknown as GroqClient;
}

function reply(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  content: string | null = null,
): ChatCompletionsResult {
  const calls: ToolCall[] = toolCalls.map((t, i) => ({
    id: `call_${i}`,
    name: t.name,
    arguments: t.args,
  }));
  return {
    content,
    toolCalls: calls,
    usage: { inputTokens: 50, outputTokens: 20 },
    model: 'mock-model',
    latencyMs: 5,
  };
}

interface CtxSpy {
  ctx: ToolContext;
  workDir: string;
  checkpoints: string[];
  enqueues: number;
  questions: Array<{ id: string; question: string }>;
}

function makeCtx(): CtxSpy {
  const spy: CtxSpy = {
    ctx: undefined as unknown as ToolContext,
    workDir: '',
    checkpoints: [],
    enqueues: 0,
    questions: [],
  };
  const git: GitOps = {
    checkpoint: async (msg: string) => {
      spy.checkpoints.push(msg);
      return SHA;
    },
    head: async () => SHA,
    status: async () => ({ clean: true, changed: [] }),
    diff: async () => '',
  };
  spy.ctx = {
    runId: 'run_director_test',
    projectId: 'proj_director_test',
    workDir: '',
    git,
    builds: {
      enqueue: async () => {
        spy.enqueues += 1;
        return { buildId: 'build_1' };
      },
      status: async () => ({ status: BuildStatus.VERIFIED, verdict: { ok: true } }),
    },
    evidence: {
      gather: async (buildId: string) => ({
        buildId,
        screenshots: 3,
        consoleErrors: 0,
        blankDetected: false,
        notes: [],
      }),
    },
    events: {
      questionAsked: async (_runId, id, question) => {
        spy.questions.push({ id, question });
      },
      toolCall: async () => undefined,
      toolResult: async () => undefined,
    },
    redactor: createSecretRedactor(),
    memory: {
      write: async (input) => ({
        id: 'mem_1',
        scope: input.scope,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
        key: input.key,
        content: input.content,
        salience: input.salience ?? 0.5,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      supersede: async () => {
        throw new Error('not implemented in test stub');
      },
      listCurrent: async () => [],
      search: async () => [],
    },
  };
  return spy;
}

const registry = {
  selectModel: () => 'mock-model',
} as unknown as ModelRegistry;

describe('runDirectorTurn', () => {
  let spy: CtxSpy;
  beforeEach(async () => {
    spy = makeCtx();
    spy.workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-director-'));
    spy.ctx.workDir = spy.workDir;
  });

  it('runs a scripted 5-step conversation to finishRun', async () => {
    const groq = scriptedGroq([
      reply([{ name: 'listFiles', args: {} }], 'Let me look at the project.'),
      reply([{ name: 'writeFile', args: { path: 'src/game.ts', content: '// game\n' } }]),
      reply([{ name: 'execBuild', args: {} }]),
      reply([{ name: 'buildStatus', args: { buildId: 'build_1' } }]),
      reply([{ name: 'finishRun', args: { summary: 'Game built and verified.' } }]),
    ]);

    const res = await runDirectorTurn({
      runId: 'run_director_test',
      workDir: spy.workDir,
      ctx: spy.ctx,
      groq,
      registry,
      budgets: new BudgetTracker({}),
      userRequest: 'Create a tiny 3D scene.',
    });

    expect(res.finished).toBe(true);
    expect(res.summary).toBe('Game built and verified.');
    expect(res.stepsTaken).toBe(5);
    expect(res.tokensUsed).toBeGreaterThan(0);
    // Checkpoint-before-edit honored exactly once, for the single write.
    expect(spy.checkpoints).toEqual(['before agent edit src/game.ts']);
    expect(await fs.readFile(path.join(spy.workDir, 'src/game.ts'), 'utf8')).toBe('// game\n');
    expect(spy.enqueues).toBe(1);
    expect((groq.chatCompletions as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
  });

  it('askUser throws PauseForUser and the loop makes no further model calls', async () => {
    const groq = scriptedGroq([
      reply([{ name: 'askUser', args: { question: 'Which color?', options: ['red', 'blue'] } }]),
      reply([{ name: 'listFiles', args: {} }]), // must never be reached
    ]);

    const err = await runDirectorTurn({
      runId: 'run_director_test',
      workDir: spy.workDir,
      ctx: spy.ctx,
      groq,
      registry,
      budgets: new BudgetTracker({}),
      userRequest: 'Make it pretty.',
    }).catch((e) => e);

    expect(isPauseForUser(err)).toBe(true);
    expect((err as PauseForUser).questionId).toBe(spy.questions[0].id);
    expect(spy.questions[0].question).toBe('Which color?');
    // The loop stopped immediately: exactly one model call, no tool side effects.
    expect((groq.chatCompletions as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(spy.enqueues).toBe(0);
    expect(spy.checkpoints).toHaveLength(0);
  });

  it('budget exhaustion mid-loop throws typed BudgetExhaustedError and halts', async () => {
    const groq = scriptedGroq([
      {
        ...reply([{ name: 'listFiles', args: {} }]),
        usage: { inputTokens: 10_000, outputTokens: 10_000 },
      },
      reply([{ name: 'listFiles', args: {} }]), // must never be reached
    ]);

    const err = await runDirectorTurn({
      runId: 'run_director_test',
      workDir: spy.workDir,
      ctx: spy.ctx,
      groq,
      registry,
      budgets: new BudgetTracker({ maxTokens: 100 }),
      userRequest: 'Do a thing.',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((groq.chatCompletions as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('exceeding maxRounds throws typed ITERATION_BUDGET_EXHAUSTED', async () => {
    const groq = scriptedGroq([
      reply([{ name: 'listFiles', args: {} }]),
      reply([{ name: 'listFiles', args: {} }]),
      reply([{ name: 'listFiles', args: {} }]),
    ]);

    const err = await runDirectorTurn({
      runId: 'run_director_test',
      workDir: spy.workDir,
      ctx: spy.ctx,
      groq,
      registry,
      budgets: new BudgetTracker({}),
      userRequest: 'Loop forever.',
      maxRounds: 2,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(
      AgentCoreErrorCode.ITERATION_BUDGET_EXHAUSTED,
    );
    expect((err as AgentCoreError).stopCode).toBe(StopCode.ITERATION_BUDGET_EXHAUSTED);
  });

  it('a model that stops calling tools returns unfinished with its text', async () => {
    const groq = scriptedGroq([reply([], 'I need more information first.')]);
    const res = await runDirectorTurn({
      runId: 'run_director_test',
      workDir: spy.workDir,
      ctx: spy.ctx,
      groq,
      registry,
      budgets: new BudgetTracker({}),
      userRequest: 'Hi.',
    });
    expect(res.finished).toBe(false);
    expect(res.summary).toBe('I need more information first.');
    expect(res.stepsTaken).toBe(0);
  });
});
