/**
 * Real GitOps implementation (server-side, Phase 3).
 *
 * - All git invocations go through execFile with argv arrays — never a shell.
 * - Repo-local identity ("GameForge Agent") so commits never depend on global
 *   git config (lesson from workspace AGENTS.md: missing identity breaks commits).
 * - checkpoint() commits the whole worktree BEFORE a mutating tool runs; if the
 *   tree is clean it returns the current HEAD (no empty commits).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import type { GitOps } from './tools.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

async function git(workDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentCoreError(
      AgentCoreErrorCode.GIT_FAILED,
      `git ${args[0]} failed: ${msg.slice(0, 300)}`,
      undefined,
      { args: args[0] },
    );
  }
}

export function createGitOps(workDir: string): GitOps {
  async function head(): Promise<string> {
    return git(workDir, ['rev-parse', 'HEAD']);
  }

  return {
    head,

    async status() {
      const out = await git(workDir, ['status', '--porcelain=v1']);
      const changed = out ? out.split('\n').map((l) => l.slice(3)) : [];
      return { clean: changed.length === 0, changed };
    },

    async diff() {
      // Stat only — full diffs can be enormous; the model reads files instead.
      return git(workDir, ['diff', 'HEAD', '--stat']);
    },

    async checkpoint(message: string): Promise<string> {
      const st = await this.status();
      if (st.clean) return head();
      await git(workDir, ['add', '-A']);
      await git(workDir, [
        'commit',
        '-m',
        message,
        '--no-verify',
        '--no-gpg-sign',
      ]);
      return head();
    },
  };
}

/**
 * Ensure workDir is a git repo with a local agent identity. Returns whether it
 * was newly initialized. Called once per run by runAgentJob — claim already
 * done by the worker.
 */
export async function ensureGitRepo(
  workDir: string,
): Promise<{ initialized: boolean; head: string }> {
  let inside = false;
  try {
    inside = (await git(workDir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    inside = false;
  }
  if (!inside) {
    await git(workDir, ['init']);
    await git(workDir, ['config', 'user.name', 'GameForge Agent']);
    await git(workDir, ['config', 'user.email', 'gameforge-agent@local']);
    await git(workDir, ['add', '-A']);
    try {
      await git(workDir, [
        'commit',
        '-m',
        'initial project snapshot',
        '--allow-empty',
        '--no-verify',
        '--no-gpg-sign',
      ]);
    } catch {
      // Commit failed for a real reason (not emptiness — --allow-empty
      // covers that); leave the repo commit-less and let head() fail loudly
      // at the call site rather than hiding it here.
      return { initialized: true, head: '' };
    }
    return { initialized: true, head: await git(workDir, ['rev-parse', 'HEAD']) };
  }
  // Existing repo: ensure a local identity exists (defensive; repo-local only).
  try {
    await git(workDir, ['config', 'user.name']);
  } catch {
    await git(workDir, ['config', 'user.name', 'GameForge Agent']);
    await git(workDir, ['config', 'user.email', 'gameforge-agent@local']);
  }
  return { initialized: false, head: await git(workDir, ['rev-parse', 'HEAD']) };
}
