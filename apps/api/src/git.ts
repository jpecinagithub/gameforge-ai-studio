import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface GitRunner {
  /** `git init -b main` + seed README + initial commit. Throws on failure. */
  initRepo(dir: string, name: string): Promise<void>;
  /** Local `git clone`. Throws on failure. */
  cloneRepo(srcDir: string, dstDir: string): Promise<void>;
}

async function git(args: string[], timeoutMs: number): Promise<void> {
  // execFile with an argv array — never a shell string. No interpolation risk.
  await execFileAsync('git', args, { timeout: timeoutMs });
}

/** Real git runner backed by the system `git` binary. */
export const realGitRunner: GitRunner = {
  async initRepo(dir: string, name: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await git(['init', '-b', 'main', dir], 30000);
    const readme = `# ${name}\n\nGameForge AI Studio project.\n`;
    await writeFile(join(dir, 'README.md'), readme);
    await git(['-C', dir, 'add', 'README.md'], 30000);
    await git(
      [
        '-C', dir,
        '-c', 'user.name=GameForge',
        '-c', 'user.email=gameforge@local',
        'commit', '-m', 'init: project created',
      ],
      30000,
    );
  },

  async cloneRepo(srcDir: string, dstDir: string): Promise<void> {
    await mkdir(dstDir, { recursive: true });
    await git(['clone', srcDir, dstDir], 120000);
  },
};
