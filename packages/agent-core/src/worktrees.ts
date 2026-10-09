/**
 * Git worktree manager for per-task isolation (Phase 4).
 *
 * Each dispatched task gets a worktree at
 *   <repoDir>/.studio/worktrees/<taskId>
 * on branch
 *   studio/runs/<runId>/<taskId>
 * The role agent edits inside the worktree; on success the orchestrator merges
 * the branch into the main checkout with --no-ff. Merge conflicts are typed
 * (MERGE_CONFLICT with the conflicting paths) — never auto-resolved, never
 * silently overwritten (Genex F8 discipline).
 *
 * All git invocations go through execFile with argv arrays — never a shell.
 * Every path is containment-checked inside repoDir before use.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import { StopCode } from '@gameforge/shared';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentCoreError(
      AgentCoreErrorCode.GIT_FAILED,
      `git ${args[0]} failed: ${msg.slice(0, 300)}`,
      StopCode.INTERRUPTED,
      { args: args[0] },
    );
  }
}

/** Resolve p inside root; throw typed error on escape. */
function contain(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const base = path.resolve(root) + path.sep;
  if (abs !== path.resolve(root) && !abs.startsWith(base)) {
    throw new AgentCoreError(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
      `Worktree path escapes repoDir: ${p}`,
      StopCode.TOOL_PERMISSION_DENIED,
    );
  }
  return abs;
}

function branchFor(runId: string, taskId: string): string {
  return `studio/runs/${runId}/${taskId}`;
}

export function worktreePathFor(repoDir: string, taskId: string): string {
  return contain(repoDir, path.join('.studio', 'worktrees', taskId));
}

/** Create a worktree for a task on its own branch. Returns the worktree path. */
export async function createWorktree(
  repoDir: string,
  runId: string,
  taskId: string,
): Promise<string> {
  const wt = worktreePathFor(repoDir, taskId);
  const branch = branchFor(runId, taskId);
  // -f: allow reuse after a crashed run left the worktree behind (the branch
  // is recreated from the current HEAD — deterministic start state).
  await git(repoDir, ['worktree', 'add', '-f', '-b', branch, wt]);
  // Worktree-local agent identity (repo-local only, never global).
  await git(wt, ['config', 'user.name', 'GameForge Agent']);
  await git(wt, ['config', 'user.email', 'gameforge-agent@local']);
  return wt;
}

/**
 * Remove a task worktree (force) and prune stale metadata. The task branch is
 * KEPT so its commits remain recoverable after a merge conflict.
 */
export async function discardWorktree(repoDir: string, worktreePath: string): Promise<void> {
  const wt = contain(repoDir, path.relative(repoDir, worktreePath));
  await git(repoDir, ['worktree', 'remove', '--force', wt]);
  await git(repoDir, ['worktree', 'prune']);
}

/**
 * Merge a task branch into the main checkout with --no-ff.
 * Requires validated=true (the caller asserts the result passed checks).
 * On conflict: aborts the merge and throws typed MERGE_CONFLICT with paths.
 */
export async function mergeWorktree(
  repoDir: string,
  runId: string,
  taskId: string,
  validated: boolean,
): Promise<{ mergedSha: string; branch: string }> {
  if (!validated) {
    throw new AgentCoreError(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
      `mergeWorktree refused: task ${taskId} not validated`,
      StopCode.TOOL_PERMISSION_DENIED,
      { taskId },
    );
  }
  const branch = branchFor(runId, taskId);
  // Merge into whatever branch the main checkout is on (usually main).
  try {
    await git(repoDir, ['merge', '--no-ff', '--no-edit', branch]);
  } catch (err) {
    const conflicts = await git(repoDir, [
      'diff',
      '--name-only',
      '--diff-filter=U',
    ]).catch(() => '');
    await git(repoDir, ['merge', '--abort']).catch(() => undefined);
    throw new AgentCoreError(
      AgentCoreErrorCode.MERGE_CONFLICT,
      `Merge conflict merging ${branch}: manual resolution required`,
      StopCode.INTERRUPTED,
      {
        branch,
        taskId,
        conflictingPaths: conflicts ? conflicts.split('\n') : [],
      },
    );
  }
  return { mergedSha: await git(repoDir, ['rev-parse', 'HEAD']), branch };
}

/** List worktrees registered for a repo (debugging/recovery). */
export async function listWorktrees(repoDir: string): Promise<string[]> {
  const out = await git(repoDir, ['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}
