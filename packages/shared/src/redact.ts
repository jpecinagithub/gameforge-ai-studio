/**
 * Secret redaction — applied BEFORE append to any event log, audit trail, prompt,
 * artifact or export (Genex's redaction-on-append, adapted).
 *
 * Two layers:
 * 1. Known values: exact strings registered at runtime (e.g. the Cloudflare
 *    API token from env, vault values). Replaced with `[REDACTED:<label>]`.
 * 2. Shape heuristics: credential-shaped patterns replaced with `[REDACTED:pattern]`.
 *    Heuristics are a backstop, never the primary mechanism. Note: Cloudflare
 *    API tokens have no documented stable prefix, so there is no
 *    provider-specific token pattern — the registered exact value (layer 1)
 *    and the generic KEY/TOKEN/SECRET assignment patterns do the work.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'genex-key', re: /genex_sk_v1_[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9\-._~+/=]{16,}/gi },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'credential-kv',
    re: /("(?:api[_-]?key|token|secret|password|passwd|pwd|auth|dsn)"\s*:\s*")([^"\\]{4,})(")/gi,
  },
  {
    name: 'env-assign',
    re: /((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|DSN)\s*=\s*["']?)([^\s;'"`]{4,})(["']?)/gi,
  },
];

export interface SecretRedactor {
  /** Register a known secret value under a label. */
  addSecret(label: string, value: string): void;
  /** Redact a string value. Non-strings pass through. */
  redactText(input: string): string;
  /** Deep-redact JSON-safe values (objects, arrays, strings). */
  redactDeep<T>(input: T): T;
}

export function createSecretRedactor(): SecretRedactor {
  const known = new Map<string, string>(); // value -> label

  function redactText(input: string): string {
    let out = input;
    for (const [value, label] of known) {
      if (value.length >= 4 && out.includes(value)) {
        out = out.split(value).join(`[REDACTED:${label}]`);
      }
    }
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, (_m, ...args) => {
        // Keep structural groups (quotes/keys), redact only the secret group.
        if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
          return `${args[0]}[REDACTED:${name}]${args[2]}`;
        }
        if (args.length >= 2 && typeof args[0] === 'string') {
          return `${args[0]}[REDACTED:${name}]`;
        }
        return `[REDACTED:${name}]`;
      });
    }
    return out;
  }

  function redactDeep<T>(input: T): T {
    if (typeof input === 'string') return redactText(input) as T;
    if (Array.isArray(input)) return input.map(redactDeep) as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        // Never let a key literally named like a secret survive with its value.
        if (/^(api[_-]?key|token|secret|password|passwd|pwd|authorization)$/i.test(k)) {
          out[k] = '[REDACTED:key-name]';
        } else {
          out[k] = redactDeep(v);
        }
      }
      return out as T;
    }
    return input;
  }

  return {
    addSecret(label: string, value: string) {
      if (value && value.length >= 4) known.set(value, label);
    },
    redactText,
    redactDeep,
  };
}

/** Shared singleton for the process. Workers/API register known secrets at boot. */
export const globalRedactor = createSecretRedactor();
