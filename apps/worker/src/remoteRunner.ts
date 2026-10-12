import type { RunJobSpec, RunResult } from 'gameforge-runner';

export async function runRemoteJob(spec: RunJobSpec): Promise<RunResult> {
  const base = (process.env.RUNNER_URL ?? 'http://runner:8092').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), spec.timeoutMs + 15_000);
  try {
    const response = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
      signal: controller.signal,
    });
    const body = await response.json() as RunResult | { error?: string; message?: string };
    if (!response.ok) {
      const failure = body as { error?: string; message?: string };
      throw new Error(`runner ${failure.error ?? response.status}: ${failure.message ?? response.statusText}`);
    }
    return body as RunResult;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`runner request timed out after ${spec.timeoutMs + 15_000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
