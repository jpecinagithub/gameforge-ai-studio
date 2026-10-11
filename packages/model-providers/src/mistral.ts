/**
 * Mistral AI client (OpenAI-compatible API).
 *
 * Uses the OpenAI-compatible endpoint:
 *   https://api.mistral.ai/v1/chat/completions
 *
 * Auth: Bearer <apiKey> (server env MISTRAL_API_KEY).
 * Free tier: $10/month in API credits, no credit card required.
 *
 * This client implements the same chatCompletions interface as CloudflareClient,
 * so it can be used interchangeably by the agent code.
 */

import {
  type ChatMessage,
  type ChatCompletionsOptions,
  type ChatCompletionsResult,
  type ToolCall,
} from './cloudflare.js';
import { ProviderError, ProviderErrorCode } from './errors.js';

export interface MistralClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class MistralClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: MistralClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new ProviderError(
        ProviderErrorCode.AUTH_ERROR,
        'MistralClient requires a non-empty apiKey (server env MISTRAL_API_KEY).',
        { retryable: false },
      );
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.mistral.ai/v1').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * Check if Mistral is configured (API key present).
   */
  static isConfigured(): boolean {
    const key = process.env['MISTRAL_API_KEY'];
    return !!key && key.trim().length > 0;
  }

  /**
   * Create from environment (MISTRAL_API_KEY).
   */
  static fromEnv(): MistralClient {
    const apiKey = process.env['MISTRAL_API_KEY'] ?? '';
    return new MistralClient({ apiKey });
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          ProviderErrorCode.BAD_REQUEST,
          `Mistral API rejected the request (HTTP ${res.status}): ${text.slice(0, 500)}`,
          { retryable: res.status >= 500 || res.status === 429 },
        );
      }

      const json = (await res.json()) as any;

      // OpenAI-compatible response format.
      const choice = json.choices?.[0];
      if (!choice) {
        throw new ProviderError(
          ProviderErrorCode.BAD_RESPONSE,
          'Mistral response missing choices[0].',
          { retryable: false },
        );
      }

      const message = choice.message ?? {};
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name ?? '',
        arguments: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments ?? {},
      }));

      const usage = json.usage ?? {};
      const latencyMs = Date.now() - startedAt;

      return {
        content: message.content ?? null,
        toolCalls,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        },
        model: json.model ?? opts.model,
        latencyMs,
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        ProviderErrorCode.NETWORK_ERROR,
        `Mistral request failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    }
  }
}
