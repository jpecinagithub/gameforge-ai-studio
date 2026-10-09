/**
 * Tool unit tests — the safety guarantees, not just happy paths.
 *
 * - writeFile: checkpoint is created BEFORE the write (behavioral proof).
 * - writeFile: expectedCommitSha mismatch → CONFLICT, file untouched.
 * - Path traversal ('../x') → validation error, nothing touches the fs.
 * - readFile/listFiles round-trip.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { createSecretRedactor } from '@gameforge/shared';
import { AgentCoreError, AgentCoreErrorCode } from '../src/errors.js';
import { executeToolCall, type GitOps, type ToolContext } from '../src/tools.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface CtxHarness {
  ctx: ToolContext;
  workDir: string;
  /** 'checkpoint' entries in call order; each records whether the target existed yet. */
  checkpointLog: Array<{ msg: string; targetExisted: boolean }>;
  head: string;
  failCheckpoint: boolean;
}

function makeHarness(): CtxHarness {
  const checkpointLog: Array<{ msg: string; targetExisted: boolean }> = [];
  let head = SHA_A;
  const h: CtxHarness = {
    workDir: '',
    checkpointLog,
    get head() {
      return head;
    },
    set head(v: string) {
      head = v;
    },
    failCheckpoint: false,
    ctx: undefined as unknown as ToolContext,
  };
  const git: GitOps = {
    checkpoint: async (msg: string) => {
      if (h.failCheckpoint) throw new Error('checkpoint boom');
      // Behavioral ordering proof: at checkpoint time the write must NOT have happened yet.
      const target = msg.replace('before agent edit ', '');
      let targetExisted = false;
      try {
        await fs.stat(path.join(h.workDir, target));
        targetExisted = true;
      } catch {
        targetExisted = false;
      }
      checkpointLog.push({ msg, targetExisted });
      return SHA_B;
    },
    head: async () => head,
    status: async () => ({ clean: true, changed: [] }),
    diff: async () => '',
  };
  h.ctx = {
    runId: 'run_test',
    workDir: '',
    git,
    builds: {
      enqueue: async () => ({ buildId: 'build_test' }),
      status: async () => ({ status: 'verified' as const }),
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
  };
  return h;
}

describe('writeFile', () => {
  let h: CtxHarness;
  beforeEach(async () => {
    h = makeHarness();
    h.workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-tools-'));
    h.ctx.workDir = h.workDir;
  });

  it('creates the git checkpoint BEFORE writing (target absent at checkpoint time)', async () => {
    const res = (await executeToolCall(
      'writeFile',
      { path: 'src/game.ts', content: 'export const x = 1;\n' },
      h.ctx,
    )) as { checkpointSha: string; path: string };

    expect(h.checkpointLog).toHaveLength(1);
    expect(h.checkpointLog[0].msg).toBe('before agent edit src/game.ts');
    // The checkpoint ran before the write: the file did not exist yet then.
    expect(h.checkpointLog[0].targetExisted).toBe(false);
    expect(res.checkpointSha).toBe(SHA_B);
    // …and the write did happen afterwards.
    expect(await fs.readFile(path.join(h.workDir, 'src/game.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('rejects on expectedCommitSha mismatch (CONFLICT) and leaves the file untouched', async () => {
    const target = path.join(h.workDir, 'src/keep.ts');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'original\n', 'utf8');

    const err = await executeToolCall(
      'writeFile',
      { path: 'src/keep.ts', content: 'MUTATED\n', expectedCommitSha: SHA_B },
      h.ctx,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.CONFLICT);
    // No checkpoint was taken for a rejected write…
    expect(h.checkpointLog).toHaveLength(0);
    // …and the file is untouched.
    expect(await fs.readFile(target, 'utf8')).toBe('original\n');
  });

  it('accepts a matching expectedCommitSha', async () => {
    await executeToolCall(
      'writeFile',
      { path: 'ok.ts', content: 'v\n', expectedCommitSha: SHA_A },
      h.ctx,
    );
    expect(h.checkpointLog).toHaveLength(1);
  });

  it('rejects path traversal without touching the filesystem', async () => {
    const outside = path.join(path.dirname(h.workDir), 'gf-escape-probe.txt');
    const err = await executeToolCall(
      'writeFile',
      { path: '../gf-escape-probe.txt', content: 'pwned' },
      h.ctx,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
    );
    expect(h.checkpointLog).toHaveLength(0);
    await expect(fs.stat(outside)).rejects.toThrow();
  });

  it('readFile and listFiles round-trip', async () => {
    await executeToolCall('writeFile', { path: 'a/b.txt', content: 'hello' }, h.ctx);
    const read = (await executeToolCall('readFile', { path: 'a/b.txt' }, h.ctx)) as {
      content: string;
    };
    expect(read.content).toBe('hello');
    const list = (await executeToolCall('listFiles', {}, h.ctx)) as { files: string[] };
    expect(list.files).toContain('a/b.txt');
  });

  it('unknown tool names fail closed', async () => {
    const err = await executeToolCall('rmEverything', {}, h.ctx).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.UNKNOWN_TOOL);
  });
});
