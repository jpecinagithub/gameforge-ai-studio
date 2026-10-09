import { ulid } from 'ulid';

/**
 * Deterministic, sortable, unguessable-enough IDs. ULIDs are time-ordered and
 * generated once at creation — never retried into duplicates.
 */
export function newRunId(): string {
  return `run_${ulid()}`;
}

export function newBuildId(): string {
  return `build_${ulid()}`;
}

export function newJobId(prefix = 'job'): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Idempotency keys for side-effecting operations (§9). Same logical operation
 * must always produce the same key so a retried worker never duplicates
 * paid/external effects.
 */
export function idempotencyKey(scope: string, ...parts: string[]): string {
  return [scope, ...parts].join(':');
}

/** Short opaque public IDs for artifacts (no sequential disclosure). */
export function newArtifactId(): string {
  return `art_${ulid()}`;
}
