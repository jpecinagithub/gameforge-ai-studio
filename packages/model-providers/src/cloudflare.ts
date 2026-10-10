/**
 * Cloudflare Workers AI client (OpenAI-compatible `/ai/v1` surface).
 *
 * Endpoints (verified against Cloudflare docs 2026-10-09):
 * - Chat:    POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
 * - Catalog: GET  https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search
 * - Auth:    Authorization: Bearer <CLOUDFLARE_API_TOKEN> (Account > Workers AI > Read)
 *
 * The catalog's `result` entries carry `{ id: <uuid>, name: "@cf/..." }` — the
 * callable model slug is `name`, NEVER the internal UUID.
 *
 * - Server-side only. The API token lives in server env (CLOUDFLARE_API_TOKEN)
 *   and is NEVER included in error messages — every error string passes through
 *   the shared secret redactor before it is constructed.
 * - Retries: exponential backoff with jitter, bounded retries ONLY on
 *   429 / 5xx / network errors / timeouts. Other 4xx throw immediately.
 * - Malformed tool-call arguments throw a typed BAD_RESPONSE error — they are
 *   never silently coerced.
 * - Billing: Workers AI meters NEURONS (10,000 free neurons/day per account as
 *   of 2026-10-09). Usage here tracks tokens; exact neuron pricing lives in
 *   the Cloudflare dashboard and is never invented in this package.
 */
import { createSecretRedactor } from '@gameforge/shared';
import { ProviderError, ProviderErrorCode } from './errors.js';

export interface CloudflareClientOptions {
  apiToken: string;
  accountId: string;
  /** Override for tests. Default https://api.cloudflare.com/client/v4 */
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

/** One entry from the Workers AI model catalog (discovery only). */
export interface CatalogModel {
  /** The callable slug, e.g. "@cf/meta/llama-3.1-8b-instruct". */
  name: string;
  taskName: string;
  description: string;
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
  throw new ProviderError(
    ProviderErrorCode.BAD_RESPONSE,
    'Cloudflare returned message content of unexpected type.',
    { status, retryable: false },
  );
}

/** Convenience factory used by the API's lazy provider interface. */
export function createCloudflareClient(
  apiToken: string,
  accountId: string,
): CloudflareClient {
  return new CloudflareClient({ apiToken, accountId });
}

export class CloudflareClient {
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly headers: Record<string, string>;
  private readonly redactor = createSecretRedactor();

  constructor(opts: CloudflareClientOptions) {
    if (!opts.apiToken || opts.apiToken.trim().length === 0) {
      throw new ProviderError(
        ProviderErrorCode.AUTH_ERROR,
        'CloudflareClient requires a non-empty apiToken (server env CLOUDFLARE_API_TOKEN).',
        { retryable: false },
      );
    }
    if (!opts.accountId || opts.accountId.trim().length === 0) {
      throw new ProviderError(
        ProviderErrorCode.AUTH_ERROR,
        'CloudflareClient requires a non-empty accountId (server env CLOUDFLARE_ACCOUNT_ID).',
        { retryable: false },
      );
    }
    this.baseUrl = (opts.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    this.accountId = opts.accountId;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.headers = {
      Authorization: `Bearer ${opts.apiToken}`,
      'Content-Type': 'application/json',
    };
    // Belt-and-braces: the token can never appear in an error string we build.
    this.redactor.addSecret('cloudflare-api-token', opts.apiToken);
  }

  private chatUrl(): string {
    return `${this.baseUrl}/accounts/${this.accountId}/ai/v1/chat/completions`;
  }

  private catalogUrl(): string {
    return (
      `${this.baseUrl}/accounts/${this.accountId}/ai/models/search` +
      `?task=${encodeURIComponent('Text Generation')}&per_page=200`
    );
  }

  /**
   * Discover text-generation models from the account catalog. Returns the
   * callable `@cf/...` slugs (never the internal UUIDs), sorted.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request('GET', this.catalogUrl(), undefined, signal);
    const body = await this.parseJson(res, 'models catalog');
    const envelope = this.parseEnvelope(body, 'models catalog', res.status);
    const models: CatalogModel[] = [];
    for (const entry of envelope) {
      if (!isPlainObject(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name : null;
      const task = isPlainObject(entry.task) ? entry.task : null;
      const taskName = task && typeof task.name === 'string' ? task.name : '';
      if (!name || !name.startsWith('@cf/')) continue;
      if (taskName !== 'Text Generation') continue;
      models.push({
        name,
        taskName,
        description: typeof entry.description === 'string' ? entry.description : '',
      });
    }
    return models.map((m) => m.name).sort();
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

    // Debug: log the exact request structure when CF_DEBUG_REQUEST=1 (diagnosing 400s).
    // Logs model, message roles/content types (not full text), and tool names.
    if (process.env.CF_DEBUG_REQUEST === '1') {
      const msgSummary = (opts.messages || []).map((m: any, i: number) => ({
        idx: i,
        role: m.role,
        contentType: m.content === null ? 'null' : Array.isArray(m.content) ? 'array' : typeof m.content,
        hasToolCalls: !!m.tool_calls,
        toolCallId: m.tool_call_id || undefined,
      }));
      console.log('[cf-debug] model:', opts.model);
      console.log('[cf-debug] messages:', JSON.stringify(msgSummary));
      console.log('[cf-debug] tools:', (opts.tools || []).map((t: any) => t.function?.name).join(','));
    }

    const res = await this.request(
      'POST',
      this.chatUrl(),
      JSON.stringify(body),
      opts.signal,
    );
    const json = await this.parseJson(res, 'chat completions');
    // Cloudflare can wrap errors in a 200 envelope: { success: false, errors }.
    // Chat completions are OpenAI-shaped (no result array), so only the
    // failure envelope is checked here.
    this.parseEnvelope(json, 'chat completions', res.status, false);
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
    method: string,
    url: string,
    body: string | undefined,
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;

    for (;;) {
      try {
        const res = await this.fetchWithTimeout(url, { method, body }, outerSignal);

        if (res.status === 429 || res.status >= 500) {
          const retryable = new ProviderError(
            res.status === 429 ? ProviderErrorCode.RATE_LIMITED : ProviderErrorCode.NETWORK_ERROR,
            this.safe(
              `Cloudflare Workers AI ${method} failed with HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}.`,
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
          throw await this.typedClientError(res, method);
        }
        return res;
      } catch (err) {
        if (err instanceof ProviderError && err.retryable && attempt < this.maxRetries) {
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
    url: string,
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
          new ProviderError(
            ProviderErrorCode.TIMEOUT,
            this.safe(`Cloudflare Workers AI request timed out after ${this.timeoutMs}ms.`),
            { retryable: true },
          ),
        );
      }, this.timeoutMs);

      const onOuterAbort = () => {
        if (settled) return;
        done();
        controller.abort();
        reject(
          new ProviderError(
            ProviderErrorCode.TIMEOUT,
            this.safe('Cloudflare Workers AI request aborted.'),
            { retryable: false },
          ),
        );
      };
      if (outerSignal?.aborted) {
        onOuterAbort();
        return;
      }
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

      fetch(url, {
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
            new ProviderError(
              ProviderErrorCode.NETWORK_ERROR,
              this.safe('Cloudflare Workers AI network error.'),
              { retryable: true, cause: err },
            ),
          );
        },
      );
    });
  }

  /** Extract the first Cloudflare envelope error message, if the body has one. */
  private async envelopeErrorMessage(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    if (!text) return '';
    try {
      const body = JSON.parse(text) as unknown;
      if (!isPlainObject(body) || !Array.isArray(body.errors)) return '';
      const first = body.errors.find(isPlainObject);
      return first && typeof first.message === 'string' ? first.message : '';
    } catch {
      return '';
    }
  }

  private async typedClientError(res: Response, method: string): Promise<ProviderError> {
    // 4xx (other than 429) are never retried.
    const status = res.status;
    const detail = await this.envelopeErrorMessage(res).catch(() => '');
    const suffix = detail ? ` Cloudflare says: ${detail}` : '';
    if (status === 401 || status === 403) {
      return new ProviderError(
        ProviderErrorCode.AUTH_ERROR,
        this.safe(
          `Cloudflare Workers AI rejected credentials (HTTP ${status}).${suffix} ` +
            'Check CLOUDFLARE_API_TOKEN (needs Account > Workers AI > Read) and CLOUDFLARE_ACCOUNT_ID.',
        ),
        { status, retryable: false },
      );
    }
    if (status === 404) {
      return new ProviderError(
        ProviderErrorCode.MODEL_NOT_FOUND,
        this.safe(
          `Cloudflare Workers AI returned 404 — the model may not exist or was retired.${suffix}`,
        ),
        { status, retryable: false },
      );
    }
    return new ProviderError(
      ProviderErrorCode.BAD_REQUEST,
      this.safe(`Cloudflare Workers AI rejected the request (HTTP ${status}).${suffix}`),
      { status, retryable: false },
    );
  }

  private async parseJson(res: Response, what: string): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text) {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe(`Cloudflare Workers AI ${what} returned an empty body.`),
        { status: res.status, retryable: false },
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe(`Cloudflare Workers AI ${what} returned non-JSON (first 120 chars redacted-safe).`),
        { status: res.status, retryable: false },
      );
    }
  }

  /**
   * Unwrap a Cloudflare API envelope `{ success, errors, result }`. Throws a
   * typed error when `success === false`. When `expectResult` is true, a
   * missing/non-array `result` is a BAD_RESPONSE.
   */
  private parseEnvelope(body: unknown, what: string, status: number, expectResult = true): unknown[] {
    if (!isPlainObject(body)) {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe(`Cloudflare Workers AI ${what} returned a non-object body.`),
        { status, retryable: false },
      );
    }
    if (body.success === false) {
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const first = errors.find(isPlainObject);
      const message =
        first && typeof first.message === 'string' ? first.message : 'unknown error';
      throw new ProviderError(
        ProviderErrorCode.BAD_REQUEST,
        this.safe(`Cloudflare Workers AI ${what} failed: ${message}`),
        { status, retryable: false },
      );
    }
    const result = body.result;
    if (expectResult && !Array.isArray(result)) {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe(`Cloudflare Workers AI ${what} returned no result array.`),
        { status, retryable: false },
      );
    }
    return Array.isArray(result) ? result : [];
  }

  private parseCompletion(
    json: unknown,
    status: number,
  ): Omit<ChatCompletionsResult, 'latencyMs'> {
    if (!isPlainObject(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe('Cloudflare Workers AI chat completions returned no choices.'),
        { status, retryable: false },
      );
    }
    const choice = json.choices[0] as unknown;
    if (!isPlainObject(choice) || !isPlainObject(choice.message)) {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe('Cloudflare Workers AI chat completions returned a choice without a message object.'),
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
        throw new ProviderError(
          ProviderErrorCode.BAD_RESPONSE,
          this.safe('Cloudflare Workers AI returned tool_calls that is not an array.'),
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
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe('Cloudflare Workers AI returned a tool call that is not an object.'),
        { status, retryable: false },
      );
    }
    const id = typeof raw.id === 'string' ? raw.id : null;
    const fn = isPlainObject(raw.function) ? (raw.function as Record<string, unknown>) : null;
    const name = fn && typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : null;
    if (!id || !name) {
      // Never invent an id or name — a malformed call is a typed error.
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe('Cloudflare Workers AI returned a tool call missing id or function.name.'),
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
        throw new ProviderError(
          ProviderErrorCode.BAD_RESPONSE,
          this.safe(`Cloudflare Workers AI tool call "${name}" returned malformed (non-JSON) arguments.`),
          { status, retryable: false },
        );
      }
    } else if (isPlainObject(argsRaw)) {
      args = argsRaw;
    } else if (argsRaw === undefined || argsRaw === null || argsRaw === '') {
      args = {};
    } else {
      throw new ProviderError(
        ProviderErrorCode.BAD_RESPONSE,
        this.safe(`Cloudflare Workers AI tool call "${name}" returned arguments of unexpected type.`),
        { status, retryable: false },
      );
    }
    return { id, name, arguments: args };
  }
}
