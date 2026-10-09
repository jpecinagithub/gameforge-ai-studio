/**
 * Git worktree manager tests (Phase 4) — real git, temp repos.
 *
 * - createWorktree: path inside repoDir, branch created.
 * - mergeWorktree: validated changes land in the main checkout.
 * - mergeWorktree without validation → typed refusal.
 * - Conflicting edits → typed MERGE_CONFLICT with paths; main checkout clean.
 * - discardWorktree removes the checkout; the branch survives (recoverable).
 * - Path escape → typed validation error.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { AgentCoreError, AgentCoreErrorCode } from '../src/errors.js';
import {
  createWorktree,
  discardWorktree,
  listWorktrees,
  mergeWorktree,
  worktreePathFor,
} from '../src/worktrees.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-wt-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@local');
  await fs.writeFile(path.join(dir, 'game.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init', '--no-verify');
  return dir;
}

describe('worktrees', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await initRepo();
  });

  it('creates a worktree inside repoDir on a task branch', async () => {
    const wt = await createWorktree(repo, 'run1', 'task_abc');
    expect(wt).toBe(path.join(repo, '.studio', 'worktrees', 'task_abc'));
    const branches = git(repo, 'branch', '--list', 'studio/runs/run1/task_abc');
    expect(branches).toContain('studio/runs/run1/task_abc');
    expect((await listWorktrees(repo)).some((w) => w === wt)).toBe(true);
    await discardWorktree(repo, wt);
  });

  it('merges validated worktree changes into the main checkout', async () => {
    const wt = await createWorktree(repo, 'run1', 'task_abc');
    await fs.writeFile(path.join(wt, 'feature.txt'), 'new feature\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'add feature', '--no-verify');
    const { mergedSha } = await mergeWorktree(repo, 'run1', 'task_abc', true);
    expect(mergedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fs.readFile(path.join(repo, 'feature.txt'), 'utf8')).toBe('new feature\n');
    await discardWorktree(repo, wt);
  });

  it('refuses to merge without validation', async () => {
    const wt = await createWorktree(repo, 'run1', 'task_abc');
    let err: unknown;
    try {
      await mergeWorktree(repo, 'run1', 'task_abc', false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).code).toBe(AgentCoreErrorCode.TOOL_VALIDATION_FAILED);
    await discardWorktree(repo, wt);
  });

  it('conflicting edits throw typed MERGE_CONFLICT and leave main clean', async () => {
    const wt = await createWorktree(repo, 'run1', 'task_abc');
    // Diverge: edit the same file on both sides.
    await fs.writeFile(path.join(wt, 'game.txt'), 'worktree version\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'worktree edit', '--no-verify');
    await fs.writeFile(path.join(repo, 'game.txt'), 'main version\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main edit', '--no-verify');

    let err: unknown;
    try {
      await mergeWorktree(repo, 'run1', 'task_abc', true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreError);
    const ace = err as AgentCoreError;
    expect(ace.code).toBe(AgentCoreErrorCode.MERGE_CONFLICT);
    expect(ace.detail?.['conflictingPaths']).toContain('game.txt');
    // Main checkout is not left mid-merge.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    await discardWorktree(repo, wt);
  });

  it('discardWorktree removes the checkout but keeps the branch', async () => {
    const wt = await createWorktree(repo, 'run1', 'task_abc');
    await discardWorktree(repo, wt);
    await expect(fs.stat(wt)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'studio/runs/run1/task_abc')).toContain(
      'studio/runs/run1/task_abc',
    );
  });

  it('path escape throws a typed validation error', () => {
    expect(() => worktreePathFor(repo, '../../../../evil')).toThrow(AgentCoreError);
  });
});
