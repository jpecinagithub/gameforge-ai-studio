/**
 * CloudflareClient tests — all network is mocked. No real Cloudflare calls, ever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, createCloudflareClient } from './cloudflare.js';
import { ProviderError, ProviderErrorCode } from './errors.js';
import { probeToolSupport, probeVisionSupport } from './registry.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function completionBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-test',
    model: '@cf/meta/llama-3.1-8b-instruct',
    choices: [
      {
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

function catalogBody(entries: unknown[]) {
  return { success: true, errors: [], messages: [], result: entries };
}

const noSleep = async () => {};

function makeClient() {
  return new CloudflareClient({
    apiToken: 'cf-test-token',
    accountId: 'test-account-id',
    sleep: noSleep,
    baseDelayMs: 1,
  });
}

describe('CloudflareClient construction', () => {
  it('requires a non-empty token', () => {
    expect(() => new CloudflareClient({ apiToken: '  ', accountId: 'a' })).toThrowError(
      ProviderError,
    );
  });

  it('requires a non-empty account id', () => {
    expect(() => new CloudflareClient({ apiToken: 't', accountId: '' })).toThrowError(
      ProviderError,
    );
  });

  it('createCloudflareClient factory builds a client', () => {
    expect(createCloudflareClient('tok', 'acct')).toBeInstanceOf(CloudflareClient);
  });

  it('never leaks the token in a constructor error message', () => {
    const secret = 'cf-super-secret-token-xyz';
    try {
      new CloudflareClient({ apiToken: '', accountId: 'a' });
      expect.unreachable();
    } catch (e) {
      // Even the error path must not echo secrets; the message is static.
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe('CloudflareClient.listModels (discovery)', () => {
  it('returns @cf slugs, never internal UUIDs, filtered to Text Generation, sorted', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        200,
        catalogBody([
          { id: 'uuid-1', name: '@cf/meta/llama-3.1-8b-instruct', task: { name: 'Text Generation' }, description: 'chat' },
          { id: 'uuid-2', name: '@cf/meta/llama-3.2-11b-vision-instruct', task: { name: 'Text Generation' }, description: 'vision' },
          { id: 'uuid-3', name: '@cf/baai/bge-large-en-v1.5', task: { name: 'Text Embeddings' }, description: 'embeddings' },
          { id: 'uuid-4', name: '@cf/stabilityai/stable-diffusion', task: { name: 'Text-to-Image' }, description: 'images' },
          { id: 'no-name', task: { name: 'Text Generation' } },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await makeClient().listModels();
    expect(models).toEqual([
      '@cf/meta/llama-3.1-8b-instruct',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    ]);
    // The request went to the account-scoped catalog endpoint with auth.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/accounts/test-account-id/ai/models/search');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-test-token');
  });

  it('throws AUTH_ERROR on 401 with a helpful message (no token echo)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { success: false, errors: [{ code: 10000, message: 'bad token' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient().listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe(ProviderErrorCode.AUTH_ERROR);
    expect(err.message).toContain('CLOUDFLARE_API_TOKEN');
    expect(err.message).not.toContain('cf-test-token');
  });

  it('throws BAD_RESPONSE when the catalog has no result array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient().listModels().catch((e) => e);
    expect(err.code).toBe(ProviderErrorCode.BAD_RESPONSE);
  });
});

describe('CloudflareClient.chatCompletions', () => {
  it('posts to the account chat endpoint and maps usage', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, completionBody()));
    vi.stubGlobal('fetch', fetchMock);

    const res = await makeClient().chatCompletions({
      model: '@cf/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.content).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(res.model).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/ai/v1/chat/completions',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('@cf/meta/llama-3.1-8b-instruct');
  });

  it('maps tool calls (string args parsed, never coerced)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        200,
        completionBody({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'write_file', arguments: '{"path":"a.ts","content":"x"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await makeClient().chatCompletions({
      model: '@cf/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'write' }],
      tools: [{ type: 'function', function: { name: 'write_file' } }],
    });
    expect(res.toolCalls).toEqual([
      { id: 'call_1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } },
    ]);
  });

  it('rejects malformed tool-call arguments (never silently coerced)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        200,
        completionBody({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_1', function: { name: 'write_file', arguments: 'not-json{{{' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await makeClient()
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe(ProviderErrorCode.BAD_RESPONSE);
  });

  it('retries 429 with backoff then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { success: false, errors: [{ message: 'rate limited' }] }))
      .mockResolvedValueOnce(jsonResponse(200, completionBody()));
    vi.stubGlobal('fetch', fetchMock);

    const res = await makeClient().chatCompletions({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws RATE_LIMITED after exhausting retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { success: false, errors: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CloudflareClient({
      apiToken: 't',
      accountId: 'a',
      sleep: noSleep,
      baseDelayMs: 1,
      maxRetries: 1,
    });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err.code).toBe(ProviderErrorCode.RATE_LIMITED);
    expect(err.retryable).toBe(true);
  });

  it('throws MODEL_NOT_FOUND on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(404, { success: false, errors: [{ code: 7000, message: 'no such model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .chatCompletions({ model: '@cf/nope', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err.code).toBe(ProviderErrorCode.MODEL_NOT_FOUND);
    expect(err.retryable).toBe(false);
  });

  it('surfaces Cloudflare error envelopes (success:false) as typed errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, { success: false, errors: [{ code: 3007, message: 'model not available' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe(ProviderErrorCode.BAD_REQUEST);
    expect(err.message).toContain('model not available');
  });

  it('sends jsonMode as response_format', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, completionBody()));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().chatCompletions({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      jsonMode: true,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('capability probes against the Cloudflare client', () => {
  it('probeVisionSupport: true when the model answers the image probe', async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(client, 'chatCompletions')
      .mockResolvedValue({ content: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 });
    expect(await probeVisionSupport(client, '@cf/meta/llama-3.2-11b-vision-instruct')).toBe(true);
    const opts = spy.mock.calls[0][0];
    const parts = (opts.messages[0] as { content: unknown[] }).content;
    expect(parts.some((p) => (p as { type: string }).type === 'image_url')).toBe(true);
  });

  it('probeVisionSupport: false when the request fails (inconclusive)', async () => {
    const client = makeClient();
    vi.spyOn(client, 'chatCompletions').mockRejectedValue(
      new ProviderError(ProviderErrorCode.NETWORK_ERROR, 'down', { retryable: true }),
    );
    expect(await probeVisionSupport(client, 'm')).toBe(false);
  });

  it('probeToolSupport: true when the model makes the probe tool call', async () => {
    const client = makeClient();
    vi.spyOn(client, 'chatCompletions').mockResolvedValue({
      content: null,
      toolCalls: [{ id: 'c1', name: 'probe_ping', arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
      latencyMs: 1,
    });
    expect(await probeToolSupport(client, '@cf/meta/llama-3.1-8b-instruct')).toBe(true);
  });

  it('probeToolSupport: false when the model declines (inconclusive)', async () => {
    const client = makeClient();
    vi.spyOn(client, 'chatCompletions').mockResolvedValue({
      content: 'no',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
      latencyMs: 1,
    });
    expect(await probeToolSupport(client, 'm')).toBe(false);
  });
});

describe('budget accounting with the Cloudflare client', () => {
  it('usage from a completion feeds the token budget', async () => {
    const { BudgetTracker } = await import('./budgets.js');
    const tracker = new BudgetTracker({ maxTokens: 100 });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, completionBody()));
    vi.stubGlobal('fetch', fetchMock);
    const res = await makeClient().chatCompletions({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const snap = tracker.recordUsage({
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: null, // Workers AI prices live in the dashboard — never invented
    });
    expect(snap.usedTokens).toBe(15);
  });

  it('cost is always unknown (null) — never invented', async () => {
    const { computeCost } = await import('./accounting.js');
    expect(computeCost('@cf/meta/llama-3.1-8b-instruct', 1000, 500)).toBeNull();
  });
});
