import { z } from 'zod';

/**
 * Separate privileges for runner operations (§10 of the master prompt).
 * The orchestrator may only request a job for a capability it holds; the runner
 * maps each capability to a pinned image allowlist and resource profile.
 */
export const Capability = {
  EDIT: 'edit',
  INSTALL: 'install',
  BUILD: 'build',
  TEST: 'test',
  PUBLISH: 'publish',
  DELETE: 'delete',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

/** Network posture for a job. Default-deny; registry-only is implemented via an
 * egress-proxy allowlist network (see README — Phase 7 wires the proxy). */
export const RunnerNetwork = {
  NONE: 'none',
  REGISTRY_ONLY: 'registry-only',
} as const;
export type RunnerNetwork = (typeof RunnerNetwork)[keyof typeof RunnerNetwork];

export const runJobSpecSchema = z.object({
  /** Stable job id, used for the container name and the per-run log file. */
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  image: z.string().min(1).max(256),
  /** Command + args executed inside the container. Never a shell string. */
  command: z.array(z.string().max(4096)).min(1).max(64),
  /** Host directory mounted at /work (rw). Must resolve inside RUNNER_WORK_ROOT. */
  workdirHostPath: z.string().min(1).max(1024),
  env: z.record(z.string().max(128), z.string().max(8192)).default({}),
  cpuQuota: z.number().min(0.1).max(16).default(1),
  memMb: z.number().int().min(64).max(16384).default(512),
  pidsLimit: z.number().int().min(16).max(4096).default(256),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  network: z.enum([RunnerNetwork.NONE, RunnerNetwork.REGISTRY_ONLY]).default(RunnerNetwork.NONE),
  capability: z.enum([
    Capability.EDIT,
    Capability.INSTALL,
    Capability.BUILD,
    Capability.TEST,
    Capability.PUBLISH,
    Capability.DELETE,
  ]),
});

export type RunJobSpec = z.infer<typeof runJobSpecSchema>;

export interface RunResult {
  /** Container process exit code; null when killed/timed out or never started. */
  exitCode: number | null;
  /** Captured stdout, tail-truncated to 256 KiB. */
  stdout: string;
  /** Captured stderr, tail-truncated to 256 KiB. */
  stderr: string;
  /** True when the timeout fired and the container was killed. */
  timedOut: boolean;
  /** Heuristic: exit 137 without a timeout. Documented, not authoritative. */
  oomKilled: boolean;
  /** True when stdout or stderr hit the truncation cap. */
  truncated: boolean;
  wallMs: number;
}

/** Typed runner failures. RUNNER_UNAVAILABLE maps to shared ApiErrorCode.RUNNER_UNAVAILABLE. */
export const RunnerErrorCode = {
  RUNNER_UNAVAILABLE: 'runner_unavailable',
  IMAGE_NOT_ALLOWED: 'image_not_allowed',
  INVALID_SPEC: 'invalid_spec',
  SPAWN_FAILED: 'spawn_failed',
} as const;
export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  constructor(code: RunnerErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = 'RunnerError';
    this.code = code;
  }
}
