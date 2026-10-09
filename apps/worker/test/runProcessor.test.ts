import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { processAgentRun, type JobLike, type RunRow } from '../src/runProcessor.js';
import type { DbPool } from '../src/db.js';
import type { ProcessorDeps } from '../src/runProcessor.js';

vi.mock('@gameforge/agent-core', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('@gameforge/agent-core')>();
  return { ...orig, runAgentJob: vi.fn(), runMultiAgentJob: vi.fn() };
});

const { runAgentJob, runMultiAgentJob, PauseForUser } = await import('@gameforge/agent-core');
const { BudgetExhaustedError } = await import('@gameforge/model-providers');
const runAgentJobMock = runAgentJob as Mock;
const runMultiAgentJobMock = runMultiAgentJob as Mock;

interface Call {
  target: 'pool' | 'client';
  text: string;
  params: unknown[] | undefined;
}

const redactor = { redactDeep: <T>(v: T): T => v };
const log = vi.fn();

function createMockDb(opts: {
  runRow: RunRow | null;
  claimRowCount?: number;
  failOn?: RegExp;
  /** When set, successive run-row SELECTs consume rows from this sequence. */
  rowSequence?: (RunRow | null)[];
  /** When set, memories queries return these rows. */
  memoryRows?: Record<string, unknown>[];
}) {
  const calls: Call[] = [];
  let currentRow: RunRow | null = opts.runRow;

  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ target: 'client', text, params });
      if (/INSERT INTO agent_events/i.test(text)) return { rows: [], rowCount: 1 };
      if (/FOR UPDATE/i.test(text)) return { rows: [{}], rowCount: 1 };
      if (/MAX\(seq\)/i.test(text)) return { rows: [{ max: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool: DbPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ target: 'pool', text, params });
      if (opts.failOn?.test(text)) throw new Error('db exploded');
      if (/FROM agent_runs/i.test(text) && /SELECT/i.test(text)) {
        if (opts.rowSequence && opts.rowSequence.length > 0) {
          const next = opts.rowSequence.shift()!;
          currentRow = next;
          return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
        }
        return { rows: currentRow ? [currentRow] : [], rowCount: currentRow ? 1 : 0 };
      }
      if (/FROM messages/i.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM projects/i.test(text)) return { rows: [{ last_good_build_id: null }], rowCount: 1 };
      if (/FROM memories/i.test(text) && opts.memoryRows) {
        return { rows: opts.memoryRows, rowCount: opts.memoryRows.length };
      }
      if (/SET status = 'planning'/i.test(text)) {
        const n = opts.claimRowCount ?? 1;
        if (n === 1 && currentRow) currentRow = { ...currentRow, status: 'planning' };
        return { rows: [], rowCount: n };
      }
      if (/SET status = 'interrupted'/i.test(text)) {
        if (currentRow) currentRow = { ...currentRow, status: 'interrupted' };
        return { rows: [], rowCount: 1 };
      }
      if (/SET status = 'failed'/i.test(text)) {
        if (currentRow) currentRow = { ...currentRow, status: 'failed' };
        return { rows: [], rowCount: 1 };
      }
      if (/SET status = 'waiting_for_user'/i.test(text)) {
        if (currentRow) currentRow = { ...currentRow, status: 'waiting_for_user' };
        return { rows: [], rowCount: 1 };
      }
      if (/SET status = 'completed'/i.test(text)) {
        if (currentRow) currentRow = { ...currentRow, status: 'completed' };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  };

  const job: JobLike & { moveToDelayed: ReturnType<typeof vi.fn> } = {
    data: { runId: 'run_01' },
    moveToDelayed: vi.fn(async () => {}),
  };
  return { pool, calls, job };
}

const baseRow = (overrides: Partial<RunRow> = {}): RunRow => ({
  id: 'run_01',
  project_id: 'proj_01',
  status: 'queued',
  mode: 'auto',
  journal: {},
  plan: null,
  ...overrides,
});

function baseDeps(pool: DbPool, overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    pool,
    redactor,
    log,
    storageRoot: '/tmp/gf-test-storage',
    groq: {} as ProcessorDeps['groq'],
    registry: {} as ProcessorDeps['registry'],
    queues: {
      enqueueBuild: vi.fn(async () => ({ buildId: 'build_01' })),
      getBuildStatus: vi.fn(async () => ({ status: 'verified' as const })),
    },
    evidence: {
      gather: vi.fn(async () => ({
        buildId: 'build_01',
        screenshots: 0,
        consoleErrors: 0,
        blankDetected: false,
        notes: [],
      })),
    },
    ...overrides,
  };
}

const directorResult = {
  summary: 'game built and verified',
  buildId: 'build_01',
  buildStatus: 'verified' as const,
  evidence: null,
  stepsTaken: 5,
  tokensUsed: 100,
  tasks: [],
  reviews: [],
  loopIterations: 1,
  stopCode: null,
};

beforeEach(() => {
  log.mockClear();
  runAgentJobMock.mockReset();
  runMultiAgentJobMock.mockReset();
});

describe('processAgentRun', () => {
  it('is a no-op on terminal runs (idempotent)', async () => {
    const { pool, calls, job } = createMockDb({
      runRow: baseRow({ status: 'completed' }),
    });
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('noop');
    expect(runMultiAgentJobMock).not.toHaveBeenCalled();
    expect(calls.some((c) => /SET status = 'planning'/i.test(c.text))).toBe(false);
  });

  it('runs the director and completes with its summary', async () => {
    const { pool, calls, job } = createMockDb({ runRow: baseRow() });
    runMultiAgentJobMock.mockResolvedValue(directorResult);
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('completed');
    expect(runMultiAgentJobMock).toHaveBeenCalledTimes(1);
    const args = runMultiAgentJobMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['runId']).toBe('run_01');
    expect(args['projectId']).toBe('proj_01');
    expect(String(args['workDir'])).toContain('proj_01');

    const completed = calls.find((c) => /SET status = 'completed'/i.test(c.text));
    expect(completed).toBeDefined();
    const journal = JSON.parse(String(completed!.params![0]));
    expect(journal.lastSummary).toBe('game built and verified');
    expect(journal.lastBuildStatus).toBe('verified');

    const kinds = calls
      .filter((c) => /INSERT INTO agent_events/i.test(c.text))
      .map((c) => c.params![3]);
    expect(kinds).toContain('completed');
  });

  it('threads the run mode to the orchestrator (manual)', async () => {
    const { pool, job } = createMockDb({ runRow: baseRow({ mode: 'manual' }) });
    runMultiAgentJobMock.mockResolvedValue(directorResult);
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('completed');
    const args = runMultiAgentJobMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['runMode']).toBe('manual');
  });

  it('fails closed with a typed error when no Groq key is configured', async () => {
    const { pool, calls, job } = createMockDb({ runRow: baseRow() });
    const res = await processAgentRun(job, baseDeps(pool, { groq: null }));
    expect(res.outcome).toBe('failed');
    expect(runMultiAgentJobMock).not.toHaveBeenCalled();
    const marked = calls.find((c) => /SET status = 'failed'/i.test(c.text));
    expect(marked).toBeDefined();
    const errPayload = JSON.parse(String(marked!.params![1]));
    expect(errPayload.code).toBe('model_unavailable');
  });

  it('parks the run as waiting_for_user when the director asks a question', async () => {
    const { pool, calls, job } = createMockDb({ runRow: baseRow() });
    runMultiAgentJobMock.mockRejectedValue(new PauseForUser('q_123'));
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('waiting');
    const parked = calls.find((c) => /SET status = 'waiting_for_user'/i.test(c.text));
    expect(parked).toBeDefined();
    const journal = JSON.parse(String(parked!.params![1]));
    expect(journal.waitingFor.questionId).toBe('q_123');
  });

  it('fails with the budget code when the director exhausts its budget', async () => {
    const { pool, calls, job } = createMockDb({ runRow: baseRow() });
    runMultiAgentJobMock.mockRejectedValue(new BudgetExhaustedError('tokens', 'test budget hit'));
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('failed');
    const marked = calls.find((c) => /SET status = 'failed'/i.test(c.text));
    const errPayload = JSON.parse(String(marked!.params![1]));
    expect(errPayload.code).toBe('budget_exhausted');
  });

  it('loses the claim gracefully when another worker wins (rowCount 0)', async () => {
    const { pool, job } = createMockDb({ runRow: baseRow(), claimRowCount: 0 });
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('noop');
    expect(runMultiAgentJobMock).not.toHaveBeenCalled();
  });

  it('re-delays the job when the run is paused', async () => {
    const { pool, job } = createMockDb({
      runRow: baseRow({ status: 'running', journal: { paused: true } }),
    });
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('paused');
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(runMultiAgentJobMock).not.toHaveBeenCalled();
  });

  it('stops mid-flight when the run is canceled before the director starts', async () => {
    const queued = baseRow();
    const planning = baseRow({ status: 'planning' });
    const canceled = baseRow({ status: 'canceled' });
    const { pool, calls, job } = createMockDb({
      runRow: queued,
      // loadRun order: initial, checkControl(pre), afterClaim, checkControl(mid)
      rowSequence: [queued, queued, planning, canceled],
    });
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('canceled');
    expect(runMultiAgentJobMock).not.toHaveBeenCalled();
    const kinds = calls
      .filter((c) => /INSERT INTO agent_events/i.test(c.text))
      .map((c) => c.params![3]);
    expect(kinds).toContain('stopped');
    expect(kinds).not.toContain('completed');
  });

  it('marks the run interrupted (not failed) on unexpected throw', async () => {
    const { pool, calls, job } = createMockDb({ runRow: baseRow() });
    runMultiAgentJobMock.mockRejectedValue(new Error('director exploded'));
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('interrupted');

    const marked = calls.find((c) => /SET status = 'interrupted'/i.test(c.text));
    expect(marked).toBeDefined();
    const errPayload = JSON.parse(String(marked!.params![0]));
    expect(errPayload.code).toBe('interrupted');

    const kinds = calls
      .filter((c) => /INSERT INTO agent_events/i.test(c.text))
      .map((c) => c.params![3]);
    expect(kinds).toContain('error');
  });

  it('injects relevant memories into the director request and passes a memory store', async () => {
    const { pool, job } = createMockDb({
      runRow: baseRow(),
      memoryRows: [
        {
          id: 'mem_1',
          scope: 'project',
          project_id: 'proj_01',
          run_id: null,
          key: 'jump-tuning',
          content: 'the player jump height is tuned to 2.5 meters',
          salience: 0.9,
          version: 1,
          created_at: '2026-10-09T10:00:00Z',
          updated_at: '2026-10-09T10:00:00Z',
        },
      ],
    });
    runMultiAgentJobMock.mockResolvedValue(directorResult);
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('completed');
    const args = runMultiAgentJobMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['memory']).toBeDefined();
    expect(typeof (args['memory'] as { write: unknown }).write).toBe('function');
    const req = String(args['userRequest']);
    expect(req).toContain('Relevant memories');
    expect(req).toContain('jump-tuning');
    expect(req).toContain('2.5 meters');
  });

  it('continues without memories when retrieval throws', async () => {
    const { pool, job } = createMockDb({
      runRow: baseRow(),
      failOn: /FROM memories/i,
    });
    runMultiAgentJobMock.mockResolvedValue(directorResult);
    const res = await processAgentRun(job, baseDeps(pool));
    expect(res.outcome).toBe('completed');
    const args = runMultiAgentJobMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(args['userRequest'])).not.toContain('Relevant memories');
  });
});
