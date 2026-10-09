/**
 * GroqCloud API client (OpenAI-compatible `/openai/v1` surface).
 *
 * - Server-side only. The API key lives in server env (GROQ_API_KEY) and is
 *   NEVER included in error messages — every error string passes through the
 *   shared secret redactor before it is constructed.
 * - Retries: exponential backoff with jitter, bounded retries ONLY on
 *   429 / 5xx / network errors / timeouts. Other 4xx throw immediately.
 * - Malformed tool-call arguments throw a typed BAD_RESPONSE error — they are
 *   never silently coerced.
 */
import { createSecretRedactor } from '@gameforge/shared';
import { GroqError, GroqErrorCode } from './errors.js';

export interface GroqClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Max retries after the initial attempt. Default 4. */
  maxRetries?: number;
  /** Base delay for backoff in ms. Default 1000. */
  baseDelayMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}
export type MessageContent = string | Array<TextPart | ImageUrlPart>;

export interface ChatMessage {
  role: ChatRole;
  content: MessageContent | null;
  name?: string;
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatCompletionsOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionsResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  latencyMs: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract text from a message content field (string | null | content-parts[]). */
function extractTextContent(content: unknown, status: number): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
    return texts.length > 0 ? texts.join('') : null;
  }
  throw new GroqError(
    GroqErrorCode.BAD_RESPONSE,
    'Groq returned message content of unexpected type.',
    { status, retryable: false },
  );
}

export class GroqClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly headers: Record<string, string>;
  private readonly redactor = createSecretRedactor();

  constructor(opts: GroqClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new GroqError(
        GroqErrorCode.AUTH_ERROR,
        'GroqClient requires a non-empty apiKey (server env GROQ_API_KEY).',
        { retryable: false },
      );
    }
    this.baseUrl = (opts.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    };
    // Belt-and-braces: the key can never appear in an error string we build.
    this.redactor.addSecret('groq-api-key', opts.apiKey);
  }

  /** GET /models → model id strings. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request('/models', { method: 'GET' }, signal);
    const body = await this.parseJson(res, '/models');
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe('GET /models returned a body without a data array.'),
        { status: res.status, retryable: false },
      );
    }
    const ids: string[] = [];
    for (const entry of data) {
      if (isPlainObject(entry) && typeof entry.id === 'string') ids.push(entry.id);
    }
    return ids;
  }

  async chatCompletions(opts: ChatCompletionsOptions): Promise<ChatCompletionsResult> {
    const startedAt = Date.now();
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
    };
    if (opts.tools) body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const res = await this.request(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(body) },
      opts.signal,
    );
    const json = await this.parseJson(res, '/chat/completions');
    const latencyMs = Date.now() - startedAt;
    return { ...this.parseCompletion(json, res.status), latencyMs };
  }

  // ---------------------------------------------------------------- internals

  /** Redact before any error string leaves this module. */
  private safe(text: string): string {
    return this.redactor.redactText(text);
  }

  private backoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, 60_000);
    }
    const capped = Math.min(this.baseDelayMs * 2 ** attempt, 30_000);
    // Full jitter.
    return Math.floor(Math.random() * (capped + 1));
  }

  private retryAfterMs(res: Response): number | undefined {
    const v = res.headers.get('retry-after');
    if (!v) return undefined;
    const secs = Number(v);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const date = Date.parse(v);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  private async request(
    path: string,
    init: { method: string; body?: string },
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;

    for (;;) {
      try {
        const res = await this.fetchWithTimeout(path, init, outerSignal);

        if (res.status === 429 || res.status >= 500) {
          const retryable = new GroqError(
            res.status === 429 ? GroqErrorCode.RATE_LIMITED : GroqErrorCode.NETWORK_ERROR,
            this.safe(
              `Groq ${path} failed with HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}.`,
            ),
            { status: res.status, retryable: true },
          );
          if (attempt < this.maxRetries) {
            await res.arrayBuffer().catch(() => undefined); // drain
            await this.sleep(this.backoffDelay(attempt, this.retryAfterMs(res)));
            attempt += 1;
            continue;
          }
          throw retryable;
        }

        if (!res.ok) {
          // 4xx (other than 429) are never retried.
          throw this.typedClientError(res, path);
        }
        return res;
      } catch (err) {
        if (err instanceof GroqError && err.retryable && attempt < this.maxRetries) {
          await this.sleep(this.backoffDelay(attempt));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Fetch with a hard timeout via Promise.race — robust even if the fetch
   * implementation ignores the abort signal (real fetch rejects on abort;
   * the race guarantees we never hang regardless).
   */
  private fetchWithTimeout(
    path: string,
    init: { method: string; body?: string },
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const done = () => {
        settled = true;
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        done();
        controller.abort();
        reject(
          new GroqError(
            GroqErrorCode.TIMEOUT,
            this.safe(`Groq request ${path} timed out after ${this.timeoutMs}ms.`),
            { retryable: true },
          ),
        );
      }, this.timeoutMs);

      const onOuterAbort = () => {
        if (settled) return;
        done();
        controller.abort();
        reject(
          new GroqError(GroqErrorCode.TIMEOUT, this.safe('Groq request aborted.'), {
            retryable: false,
          }),
        );
      };
      if (outerSignal?.aborted) {
        onOuterAbort();
        return;
      }
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

      fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers,
        body: init.body,
        signal: controller.signal,
      }).then(
        (res) => {
          if (settled) return;
          done();
          resolve(res);
        },
        (err) => {
          if (settled) return;
          done();
          // DNS / refused / reset — retryable. (Our own timeout already
          // rejected above via the race, so this is a genuine network error.)
          reject(
            new GroqError(GroqErrorCode.NETWORK_ERROR, this.safe(`Groq network error on ${path}.`), {
              retryable: true,
              cause: err,
            }),
          );
        },
      );
    });
  }

  private typedClientError(res: Response, path: string): GroqError {
    // 4xx (other than 429) are never retried.
    const status = res.status;
    if (status === 401 || status === 403) {
      return new GroqError(
        GroqErrorCode.AUTH_ERROR,
        this.safe(`Groq ${path} rejected credentials (HTTP ${status}). Check GROQ_API_KEY.`),
        { status, retryable: false },
      );
    }
    if (status === 404) {
      return new GroqError(
        GroqErrorCode.MODEL_NOT_FOUND,
        this.safe(`Groq ${path} returned 404 — the model may not exist or was retired.`),
        { status, retryable: false },
      );
    }
    return new GroqError(
      GroqErrorCode.BAD_REQUEST,
      this.safe(`Groq ${path} rejected the request (HTTP ${status}).`),
      { status, retryable: false },
    );
  }

  private async parseJson(res: Response, path: string): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text) {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe(`Groq ${path} returned an empty body.`),
        { status: res.status, retryable: false },
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe(`Groq ${path} returned non-JSON (first 120 chars redacted-safe).`),
        { status: res.status, retryable: false },
      );
    }
  }

  private parseCompletion(
    json: unknown,
    status: number,
  ): Omit<ChatCompletionsResult, 'latencyMs'> {
    if (!isPlainObject(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe('Groq /chat/completions returned no choices.'),
        { status, retryable: false },
      );
    }
    const choice = json.choices[0] as unknown;
    if (!isPlainObject(choice) || !isPlainObject(choice.message)) {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe('Groq /chat/completions returned a choice without a message object.'),
        { status, retryable: false },
      );
    }
    const message = choice.message as Record<string, unknown>;
    // Content may be a string, null (tool-call-only replies), or an array of
    // content parts (e.g. vision responses). We extract text deterministically.
    const content = extractTextContent(message.content, status);

    const toolCalls: ToolCall[] = [];
    const rawCalls = message.tool_calls;
    if (rawCalls !== undefined && rawCalls !== null) {
      if (!Array.isArray(rawCalls)) {
        throw new GroqError(
          GroqErrorCode.BAD_RESPONSE,
          this.safe('Groq returned tool_calls that is not an array.'),
          { status, retryable: false },
        );
      }
      for (const raw of rawCalls) {
        toolCalls.push(this.parseToolCall(raw, status));
      }
    }

    const usageRaw = isPlainObject(json.usage) ? (json.usage as Record<string, unknown>) : {};
    const inputTokens =
      typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : 0;
    const outputTokens =
      typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : 0;
    const model = typeof json.model === 'string' ? json.model : '';

    return { content, toolCalls, usage: { inputTokens, outputTokens }, model };
  }

  private parseToolCall(raw: unknown, status: number): ToolCall {
    if (!isPlainObject(raw)) {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe('Groq returned a tool call that is not an object.'),
        { status, retryable: false },
      );
    }
    const id = typeof raw.id === 'string' ? raw.id : null;
    const fn = isPlainObject(raw.function) ? (raw.function as Record<string, unknown>) : null;
    const name = fn && typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : null;
    if (!id || !name) {
      // Never invent an id or name — a malformed call is a typed error.
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe('Groq returned a tool call missing id or function.name.'),
        { status, retryable: false },
      );
    }
    const argsRaw = fn?.arguments;
    let args: Record<string, unknown>;
    if (typeof argsRaw === 'string') {
      try {
        const parsed: unknown = JSON.parse(argsRaw);
        if (!isPlainObject(parsed)) {
          throw new Error('not an object');
        }
        args = parsed;
      } catch {
        // Malformed arguments are NEVER silently coerced (AGENT JOB lesson:
        // string-typed arguments once killed tool-calling tasks).
        throw new GroqError(
          GroqErrorCode.BAD_RESPONSE,
          this.safe(`Groq tool call "${name}" returned malformed (non-JSON) arguments.`),
          { status, retryable: false },
        );
      }
    } else if (isPlainObject(argsRaw)) {
      args = argsRaw;
    } else if (argsRaw === undefined || argsRaw === null || argsRaw === '') {
      args = {};
    } else {
      throw new GroqError(
        GroqErrorCode.BAD_RESPONSE,
        this.safe(`Groq tool call "${name}" returned arguments of unexpected type.`),
        { status, retryable: false },
      );
    }
    return { id, name, arguments: args };
  }
}
