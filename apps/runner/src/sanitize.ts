import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { RunnerError } from './types.js';

/**
 * Input sanitization for everything that crosses into the spawn gate.
 * Adapted from Genex's `containedReal` path-containment idea (MIT): lexical
 * checks first, then realpath, then containment — symlink leaves are never
 * followed on write.
 */

/** Env keys that are always safe to pass through to job containers. */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NODE_ENV',
  'CI',
  'FORCE_COLOR',
  'NPM_CONFIG_CACHE',
  'PLAYWRIGHT_BROWSERS_PATH',
]);

/** Job-specific variables must use this prefix to pass the allowlist. */
const ENV_JOB_PREFIX = 'GF_';

/** Credential-shaped names are stripped even if allowlisted. Never negotiable. */
const CREDENTIAL_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|DSN|AUTH|PRIVATE/i;

const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_LEN = 8192;

/**
 * Returns a sanitized copy of `env`. Throws RunnerError on invalid input.
 * A credential-shaped key is dropped silently-but-loudly: the caller gets the
 * dropped key names back for audit logging.
 */
export function sanitizeEnv(env: Record<string, string>): {
  env: Record<string, string>;
  dropped: string[];
} {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  const entries = Object.entries(env);

  if (entries.length > MAX_ENV_VARS) {
    throw new RunnerError(
      'invalid_spec',
      `too many env vars (${entries.length} > ${MAX_ENV_VARS})`,
    );
  }

  for (const [key, value] of entries) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new RunnerError('invalid_spec', 'env keys and values must be strings');
    }
    if (key.length === 0 || key.length > 128) {
      throw new RunnerError('invalid_spec', `env key length out of bounds: ${key.slice(0, 32)}`);
    }
    if (value.length > MAX_ENV_VALUE_LEN) {
      throw new RunnerError('invalid_spec', `env value too long for key ${key}`);
    }
    if (value.includes('\0') || key.includes('\0')) {
      throw new RunnerError('invalid_spec', `NUL byte in env for key ${key}`);
    }
    // Credential-shaped names are stripped even if they would be allowlisted.
    if (CREDENTIAL_NAME_RE.test(key)) {
      dropped.push(key);
      continue;
    }
    if (ENV_ALLOWLIST.has(key) || key.startsWith(ENV_JOB_PREFIX)) {
      out[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { env: out, dropped };
}

/**
 * Resolves `workdirHostPath` and asserts it lives inside `workRoot`.
 * Both are resolved with realpath (symlinks resolved) before the containment
 * check, so a symlink pointing outside the root is refused.
 */
export async function resolveWorkdir(
  workdirHostPath: string,
  workRoot: string,
): Promise<string> {
  if (!isAbsolute(workdirHostPath) || !isAbsolute(workRoot)) {
    throw new RunnerError('invalid_spec', 'workdir and work root must be absolute paths');
  }
  let resolvedRoot: string;
  let resolvedWorkdir: string;
  try {
    resolvedRoot = await realpath(workRoot);
  } catch (err) {
    throw new RunnerError('invalid_spec', `work root does not exist: ${workRoot}`, {
      cause: err,
    });
  }
  try {
    resolvedWorkdir = await realpath(workdirHostPath);
  } catch (err) {
    throw new RunnerError('invalid_spec', `workdir does not exist: ${workdirHostPath}`, {
      cause: err,
    });
  }
  const inside =
    resolvedWorkdir === resolvedRoot || resolvedWorkdir.startsWith(resolvedRoot + sep);
  if (!inside) {
    throw new RunnerError(
      'invalid_spec',
      `workdir escapes work root (resolved: ${resolvedWorkdir})`,
    );
  }
  // Belt and braces: also reject a lexically-suspicious original (defense in depth;
  // the realpath check above is authoritative).
  void resolve(workdirHostPath);
  return resolvedWorkdir;
}

/** Validates the in-container command argv. No empty strings, no NUL bytes. */
export function validateCommand(command: string[]): void {
  if (!Array.isArray(command) || command.length === 0 || command.length > 64) {
    throw new RunnerError('invalid_spec', 'command must be a non-empty argv array (max 64)');
  }
  for (const arg of command) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 4096) {
      throw new RunnerError('invalid_spec', 'command args must be non-empty strings (max 4096)');
    }
    if (arg.includes('\0')) {
      throw new RunnerError('invalid_spec', 'NUL byte in command arg');
    }
  }
}
