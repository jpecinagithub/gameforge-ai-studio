import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
} from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { globalRedactor } from '@gameforge/shared';
import { isImageAllowed } from './images.js';
import { resolveWorkdir, sanitizeEnv, validateCommand } from './sanitize.js';
import {
  Capability,
  RunnerError,
  RunnerNetwork,
  runJobSpecSchema,
  type RunJobSpec,
  type RunResult,
} from './types.js';

/**
 * The spawn gate. This module is the ONLY component in the system allowed to
 * touch the Docker socket / CLI — the direct analogue of Genex's ProcessSandbox
 * living in trusted Electron main (MIT). Everything else (API, workers,
 * orchestrator) talks to this library; nothing else spawns containers.
 *
 * Hard rules:
 * - No host execution of untrusted code. Ever. If Docker is unavailable the
 *   job fails closed with RUNNER_UNAVAILABLE — there is no fallback.
 * - `docker run` is built as an explicit argv array. No shell, no string
 *   interpolation, no `--env-file`.
 * - Images come only from the pinned per-capability allowlist; `--pull never`.
 */

const OUTPUT_CAP = 256 * 1024; // 256 KiB per stream, tail-kept
const KILL_GRACE_MS = 5_000;
const DOCKER_CHECK_TTL_MS = 30_000;

/** Writable /tmp per capability (rootfs is always read-only). */
const TMPFS_SIZE: Record<Capability, string> = {
  [Capability.EDIT]: '128m',
  [Capability.INSTALL]: '512m',
  [Capability.BUILD]: '512m',
  [Capability.TEST]: '512m',
  [Capability.PUBLISH]: '256m',
  [Capability.DELETE]: '64m',
};

/** Network for registry-only jobs. Must exist with an egress proxy; if it is
 * missing, `docker run` fails closed. Wired in Phase 7 (see infra/deploy). */
const EGRESS_NETWORK = 'gf-egress';

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { stdio: 'pipe' },
) => ChildProcess;

export interface RunnerDeps {
  spawnFn?: SpawnFn;
  execFileFn?: typeof nodeExecFile;
  workRoot?: string;
  logRoot?: string;
  dockerBin?: string;
}

export interface RunnerConfig {
  workRoot: string;
  logRoot: string;
  dockerBin: string;
}

export function resolveConfig(deps?: RunnerDeps): RunnerConfig {
  return {
    workRoot: deps?.workRoot ?? process.env.RUNNER_WORK_ROOT ?? '/var/lib/gameforge/work',
    logRoot: deps?.logRoot ?? process.env.RUNNER_LOG_ROOT ?? '/var/lib/gameforge/runner-logs',
    dockerBin: deps?.dockerBin ?? process.env.GF_DOCKER_BIN ?? 'docker',
  };
}

/* ---------------- docker availability gate ---------------- */

let dockerCheckCache: { at: number; ok: boolean } | null = null;

/** @internal — test seam to reset the availability cache. */
export function _resetDockerAvailableCache(): void {
  dockerCheckCache = null;
}

export async function dockerAvailable(deps?: RunnerDeps): Promise<boolean> {
  const { dockerBin } = resolveConfig(deps);
  const execFileFn = deps?.execFileFn ?? nodeExecFile;
  const now = Date.now();
  if (dockerCheckCache && now - dockerCheckCache.at < DOCKER_CHECK_TTL_MS) {
    return dockerCheckCache.ok;
  }
  const execFileAsync = promisify(execFileFn);
  try {
    await execFileAsync(dockerBin, ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 10_000,
    });
    dockerCheckCache = { at: now, ok: true };
    return true;
  } catch {
    dockerCheckCache = { at: now, ok: false };
    return false;
  }
}

/* ---------------- argv construction (pure, unit-testable) ---------------- */

export interface BuiltCommand {
  argv: string[];
  containerName: string;
  resolvedWorkdir: string;
  env: Record<string, string>;
  droppedEnv: string[];
}

export async function buildDockerArgv(
  spec: RunJobSpec,
  config: RunnerConfig,
): Promise<BuiltCommand> {
  validateCommand(spec.command);
  const { env, dropped } = sanitizeEnv(spec.env);
  const resolvedWorkdir = await resolveWorkdir(spec.workdirHostPath, config.workRoot);

  if (!isImageAllowed(spec.capability, spec.image)) {
    throw new RunnerError(
      'image_not_allowed',
      `image ${spec.image} is not allowlisted for capability ${spec.capability}`,
    );
  }

  const containerName = `gf-${spec.jobId}`;
  const argv: string[] = [
    'run',
    '--rm',
    '--init',
    `--name=${containerName}`,
    '--user=65532:65532', // dedicated non-root user
    '--read-only', // read-only root filesystem, always
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${TMPFS_SIZE[spec.capability]}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--cpus=${spec.cpuQuota}`,
    `--memory=${spec.memMb}m`,
    `--memory-swap=${spec.memMb}m`, // no swap games
    `--pids-limit=${spec.pidsLimit}`,
    '--ulimit=nofile=1024:1024',
    '--stop-timeout=10',
    '--log-driver=none', // we capture via pipe and write our own per-run log
    '--pull=never', // images pre-pulled at deploy; no surprise pulls
    spec.network === RunnerNetwork.REGISTRY_ONLY ? `--network=${EGRESS_NETWORK}` : '--network=none',
    '-v',
    `${resolvedWorkdir}:/work:rw`, // the ONE mount: the job's own workspace
    '--workdir=/work',
  ];
  for (const [k, v] of Object.entries(env)) {
    argv.push('--env', `${k}=${v}`); // separate argv items — never a shell string
  }
  argv.push(spec.image, ...spec.command);
  return { argv, containerName, resolvedWorkdir, env, droppedEnv: dropped };
}

/* ---------------- execution ---------------- */

interface Collected {
  text: string;
  truncated: boolean;
}

function collectCapped(stream: NodeJS.ReadableStream, cap: number): Promise<Collected> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    stream.on('data', (d: Buffer) => {
      chunks.push(d);
      total += d.length;
      while (total > cap && chunks.length > 0) {
        const dropped = chunks.shift()!;
        total -= dropped.length;
        truncated = true;
      }
    });
    stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }));
    stream.on('error', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }));
  });
}

async function writeRunLog(
  logRoot: string,
  jobId: string,
  lines: string[],
): Promise<void> {
  try {
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const redacted = lines.map((l) => globalRedactor.redactText(l)).join('\n');
    await writeFile(join(logRoot, `${jobId}.log`), redacted + '\n', { mode: 0o600 });
  } catch {
    // Observability must never fail the job. The result still carries everything.
  }
}

export async function runJob(rawSpec: unknown, deps?: RunnerDeps): Promise<RunResult> {
  const parsed = runJobSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    throw new RunnerError('invalid_spec', `invalid job spec: ${parsed.error.message}`);
  }
  const spec = parsed.data;
  const config = resolveConfig(deps);
  const startedAt = Date.now();

  // Fail fast on invalid specs BEFORE touching Docker.
  const built = await buildDockerArgv(spec, config);

  // The gate: no Docker → fail closed. No host-exec fallback exists.
  const available = await dockerAvailable(deps);
  if (!available) {
    throw new RunnerError(
      'runner_unavailable',
      'container runtime unavailable; refusing to execute untrusted code on the host',
    );
  }

  const spawnFn: SpawnFn = deps?.spawnFn ?? nodeSpawn;
  const execFileFn = deps?.execFileFn ?? nodeExecFile;

  const child = spawnFn(config.dockerBin, built.argv, { stdio: 'pipe' });
  if (!child.stdout || !child.stderr) {
    throw new RunnerError('spawn_failed', 'container process stdio unavailable');
  }

  // Collect output first-class: listeners attach immediately so nothing is lost.
  const outPromise = collectCapped(child.stdout, OUTPUT_CAP);
  const errPromise = collectCapped(child.stderr, OUTPUT_CAP);

  let exitCode: number | null = null;
  let timedOut = false;
  let resolveClose!: (code: number | null) => void;
  const closePromise = new Promise<number | null>((resolve) => {
    resolveClose = resolve;
  });
  child.on('error', () => resolveClose(null));
  child.on('close', (code) => resolveClose(code));

  // Arm the timeout BEFORE awaiting anything: a hung child must never hang us.
  const timeout = setTimeout(() => {
    timedOut = true;
    // Stop the container by name first (killing the CLI client does NOT stop
    // the container), then SIGKILL the client.
    try {
      execFileFn(config.dockerBin, ['kill', built.containerName], () => {});
    } catch {
      /* best effort */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, spec.timeoutMs);

  const [out, err] = await Promise.all([outPromise, errPromise]);
  // Give the process a short grace to report its exit after streams closed.
  exitCode = await Promise.race([
    closePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), KILL_GRACE_MS)),
  ]);
  clearTimeout(timeout);
  if (exitCode === null && !timedOut) {
    // Wedged child that outlived the grace: final kill attempt (not a timeout).
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  const wallMs = Date.now() - startedAt;
  // Heuristic, documented: plain SIGKILL (137) with no timeout almost always
  // means the kernel OOM-killer fired (we never docker-kill except on timeout).
  const oomKilled = !timedOut && exitCode === 137;

  const result: RunResult = {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    timedOut,
    oomKilled,
    truncated: out.truncated || err.truncated,
    wallMs,
  };

  await writeRunLog(config.logRoot, spec.jobId, [
    `[${new Date(startedAt).toISOString()}] job=${spec.jobId} capability=${spec.capability} image=${spec.image}`,
    `command: ${JSON.stringify(spec.command)}`,
    `argv: ${JSON.stringify(built.argv)}`,
    `workdir: ${built.resolvedWorkdir}`,
    `dropped env keys: ${JSON.stringify(built.droppedEnv)}`,
    `limits: cpus=${spec.cpuQuota} mem=${spec.memMb}m pids=${spec.pidsLimit} timeout=${spec.timeoutMs}ms network=${spec.network}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
    '--- result ---',
    JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      oomKilled: result.oomKilled,
      truncated: result.truncated,
      wallMs: result.wallMs,
    }),
  ]);

  return result;
}
