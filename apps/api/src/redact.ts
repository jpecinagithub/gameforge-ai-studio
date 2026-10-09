import { globalRedactor } from '@gameforge/shared';

/**
 * Register known secret values so they are redacted from every log line,
 * error message and event payload (redaction-on-append, adapted from Genex).
 * Call once at boot, before the server starts accepting traffic.
 */
export function initRedaction(): void {
  const secrets: Array<[string, string | undefined]> = [
    ['cloudflare-token', process.env.CLOUDFLARE_API_TOKEN],
    ['database-url', process.env.DATABASE_URL],
    ['redis-url', process.env.REDIS_URL],
  ];
  for (const [label, value] of secrets) {
    if (value) globalRedactor.addSecret(label, value);
  }
}

/** Redact a free-text message before it leaves the process boundary. */
export function safeMessage(input: string): string {
  return globalRedactor.redactText(input);
}
