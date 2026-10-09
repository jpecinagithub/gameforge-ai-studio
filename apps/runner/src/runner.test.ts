import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDockerAvailableCache,
  runJob,
  type SpawnFn,
} from './runner.js';
import { sanitizeEnv, resolveWorkdir, validateCommand } from './sanitize.js';
import { isImageAllowed } from './images.js';
import { Capability, RunnerError, RunnerNetwork } from './types.js';

/** Fake docker CLI child process. */
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killedWith: string | null = null;

  kill(signal = 'SIGTERM'): boolean {
    this.killedWith = signal;
    // Simulate process death: stdio ends, then 'close'.
    this.stdout.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit('close', null));
    return true;
  }

  /** Simulate normal container completion. */
  finish(code: number, out = '', err = ''): void {
    if (out) this.stdout.push(out);
    if (err) this.stderr.push(err);
    this.stdout.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit('close', code));
  }
}

function successExecFile(): (
  file: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout?: string, stderr?: string) => void,
) => void {
  return (_file, _args, _opts, cb) => cb(null, '24.0.0', '');
}

function failingExecFile(): (
  file: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null) => void,
) => void {
  return (_file, _args, _opts, cb) => cb(new Error('docker not found'));
}

let root: string;
let workRoot: string;
let logRoot: string;
let jobDir: string;

beforeEach(async () => {
  _resetDockerAvailableCache();
  root = await mkdtemp(join(tmpdir(), 'gf-runner-test-'));
  workRoot = join(root, 'work');
  logRoot = join(root, 'logs');
  jobDir = join(workRoot, 'job1');
  await mkdir(jobDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'testjob1',
    image: 'node:22-bookworm-slim',
    command: ['node', '--version'],
    workdirHostPath: jobDir,
    env: { GF_JOB: '1', PATH: '/usr/bin' },
    cpuQuota: 1,
    memMb: 512,
    pidsLimit: 256,
    timeoutMs: 30_000,
    network: RunnerNetwork.NONE,
    capability: Capability.BUILD,
    ...overrides,
  };
}

describe('image allowlist', () => {
  it('refuses an image not on the capability allowlist', async () => {
    await expect(
      runJob(baseSpec({ image: 'evil:latest' }), {
        workRoot,
        logRoot,
        execFileFn: successExecFile() as never,
      }),
    ).rejects.toMatchObject({ code: 'image_not_allowed' });
  });

  it('allows listed images per capability', () => {
    expect(isImageAllowed(Capability.TEST, 'mcr.microsoft.com/playwright:v1.63.0-noble')).toBe(true);
    expect(isImageAllowed(Capability.BUILD, 'mcr.microsoft.com/playwright:v1.63.0-noble')).toBe(false);
    expect(isImageAllowed(Capability.DELETE, 'alpine:3.20')).toBe(true);
  });
});

describe('sanitizeEnv', () => {
  it('strips credential-shaped keys even when passed explicitly', () => {
    const { env, dropped } = sanitizeEnv({
      CLOUDFLARE_API_TOKEN: 'gsk_testsecret123',
      MY_TOKEN: 'abc',
      db_PASSWORD: 'hunter2',
      PATH: '/usr/bin',
      GF_JOB: '1',
      OTHER: 'x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', GF_JOB: '1' });
    expect(dropped).toEqual(
      expect.arrayContaining(['CLOUDFLARE_API_TOKEN', 'MY_TOKEN', 'db_PASSWORD', 'OTHER']),
    );
  });

  it('rejects oversized env values', () => {
    expect(() => sanitizeEnv({ GF_BIG: 'x'.repeat(9000) })).toThrow(RunnerError);
  });
});

describe('resolveWorkdir', () => {
  it('rejects a workdir outside the root', async () => {
    await expect(resolveWorkdir('/etc', workRoot)).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });

  it('rejects a symlink escape', async () => {
    const link = join(workRoot, 'evil-link');
    await symlink('/etc', link);
    await expect(resolveWorkdir(link, workRoot)).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });

  it('accepts a workdir inside the root', async () => {
    await expect(resolveWorkdir(jobDir, workRoot)).resolves.toBe(jobDir);
  });
});

describe('validateCommand', () => {
  it('rejects empty argv and empty args', () => {
    expect(() => validateCommand([])).toThrow(RunnerError);
    expect(() => validateCommand(['node', ''])).toThrow(RunnerError);
  });
});

describe('runJob argv hardening', () => {
  it('builds a hardened argv and runs to completion', async () => {
    const seen: { file: string; argv: string[] }[] = [];
    const fake = new FakeChild();
    const spawnFn: SpawnFn = ((file: string, argv: string[]) => {
      seen.push({ file, argv });
      setImmediate(() => fake.finish(0, 'v22.0.0\n'));
      return fake as never;
    }) as SpawnFn;

    const result = await runJob(
      baseSpec({ env: { GF_JOB: '1', CLOUDFLARE_API_TOKEN: 'gsk_testsecret123' } }),
      { spawnFn, execFileFn: successExecFile() as never, workRoot, logRoot },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('v22.0.0');

    const argv = seen[0].argv;
    for (const flag of [
      '--user=65532:65532',
      '--read-only',
      '--network=none',
      '--pids-limit=256',
      '--pull=never',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--init',
    ]) {
      expect(argv).toContain(flag);
    }
    expect(argv).not.toContain('--env-file');
    // Single mount: the job workdir, nothing else.
    const mounts = argv.filter((a, i) => argv[i - 1] === '-v');
    expect(mounts).toEqual([`${jobDir}:/work:rw`]);
    // Dropped env never reaches the container.
    expect(argv.join(' ')).not.toContain('gsk_testsecret123');
    expect(argv).toContain('GF_JOB=1');

    // Per-run log written and redacted.
    const log = await readFile(join(logRoot, 'testjob1.log'), 'utf8');
    expect(log).toContain('testjob1');
    expect(log).not.toContain('gsk_testsecret123');
  });

  it('uses the egress network for registry-only jobs', async () => {
    const seen: string[][] = [];
    const fake = new FakeChild();
    const spawnFn = ((_: string, argv: string[]) => {
      seen.push(argv);
      setImmediate(() => fake.finish(0));
      return fake as never;
    }) as unknown as SpawnFn;

    await runJob(baseSpec({ network: RunnerNetwork.REGISTRY_ONLY }), {
      spawnFn,
      execFileFn: successExecFile() as never,
      workRoot,
      logRoot,
    });
    expect(seen[0]).toContain('--network=gf-egress');
  });
});

describe('timeout', () => {
  it('kills the container and reports timedOut', async () => {
    const kills: string[][] = [];
    const fake = new FakeChild();
    const spawnFn = ((_: string, _argv: string[]) => fake as never) as unknown as SpawnFn;
    const execFileFn = ((
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (err: null) => void,
    ) => {
      kills.push(args);
      cb(null);
    }) as never;

    const result = await runJob(baseSpec({ timeoutMs: 1000 }), {
      spawnFn,
      execFileFn,
      workRoot,
      logRoot,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(fake.killedWith).toBe('SIGKILL');
    // The container itself is killed by name — killing the CLI is not enough.
    expect(kills).toContainEqual(['kill', 'gf-testjob1']);
  });
});

describe('docker availability gate', () => {
  it('fails closed with RUNNER_UNAVAILABLE when docker is missing', async () => {
    await expect(
      runJob(baseSpec(), {
        spawnFn: (() => {
          throw new Error('should not spawn');
        }) as unknown as SpawnFn,
        execFileFn: failingExecFile() as never,
        workRoot,
        logRoot,
      }),
    ).rejects.toMatchObject({ code: 'runner_unavailable' });
  });
});

describe('spec validation', () => {
  it('rejects a malformed spec', async () => {
    await expect(runJob({ jobId: 'x y z' }, { workRoot, logRoot })).rejects.toThrow(
      RunnerError,
    );
  });
});
