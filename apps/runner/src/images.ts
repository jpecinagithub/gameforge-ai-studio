import type { Capability } from './types.js';

/**
 * Pinned image allowlist, one list per capability (§10: separated privileges).
 *
 * Rules:
 * - Only exact `name:tag` pins are allowed. No `latest`, no digests-by-convention
 *   (a digest pin is fine too, but the tag pin is what we audit).
 * - `--pull never` is enforced at spawn time: images must be pre-pulled during
 *   deploy. A job can never trigger a surprise pull.
 * - Update pins deliberately: bump, verify the new image builds/tests green,
 *   then commit. Never widen the list "temporarily".
 */
export const IMAGE_ALLOWLIST: Record<Capability, string[]> = {
  // File edits by agents: node toolchain, no network.
  edit: ['node:22-bookworm-slim'],
  // Dependency installation: node toolchain, registry egress only.
  install: ['node:22-bookworm-slim'],
  // Production builds: node toolchain, no network (deps vendored at install).
  build: ['node:22-bookworm-slim'],
  // Tests incl. headless Chromium smoke tests: node + Playwright browsers.
  test: ['node:22-bookworm-slim', 'mcr.microsoft.com/playwright:v1.63.0-noble'],
  // Artifact staging for export: node toolchain, no network.
  publish: ['node:22-bookworm-slim'],
  // Resource cleanup: minimal image, no network.
  delete: ['alpine:3.20'],
};

export function isImageAllowed(capability: Capability, image: string): boolean {
  return (IMAGE_ALLOWLIST[capability] ?? []).includes(image);
}
