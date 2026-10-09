/**
 * GroqClient tests — all network is mocked. No real Groq calls, ever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqClient } from './groq.js';
import { GroqError, GroqErrorCode } from './errors.js';

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
    model: 'test-model',
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

const noSleep = async () => {};

describe('GroqClient retries', () => {
  it('retries 429 twice, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }))
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, completionBody()));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GroqClient({
      apiKey: 'gsk_test_key',
      sleep: noSleep,
      baseDelayMs: 1,
    });
    const res = await client.chatCompletions({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.content).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries on persistent 500s', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep, maxRetries: 2 });
    await expect(
      client.chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: GroqErrorCode.NETWORK_ERROR, retryable: true });
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('GroqClient client errors', () => {
  it('400 throws BAD_REQUEST immediately without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: 'bad' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GroqError);
    expect(err.code).toBe(GroqErrorCode.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 maps to AUTH_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'bad key' } })),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err.code).toBe(GroqErrorCode.AUTH_ERROR);
  });

  it('404 maps to MODEL_NOT_FOUND', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(404, { error: { message: 'no such model' } })),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err.code).toBe(GroqErrorCode.MODEL_NOT_FOUND);
  });
});

describe('GroqClient timeout', () => {
  it('aborts a hanging request with TIMEOUT', async () => {
    // Never settles and ignores the abort signal — the race must still win.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    const client = new GroqClient({
      apiKey: 'gsk_test_key',
      sleep: noSleep,
      timeoutMs: 30,
      maxRetries: 1,
    });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GroqError);
    expect(err.code).toBe(GroqErrorCode.TIMEOUT);
  });
});

describe('GroqClient tool calls', () => {
  it('parses valid tool calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
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
                      function: { name: 'write_file', arguments: '{"path":"a.ts"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        ),
      ),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const res = await client.chatCompletions({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.toolCalls).toEqual([
      { id: 'call_1', name: 'write_file', arguments: { path: 'a.ts' } },
    ]);
    expect(res.content).toBeNull();
  });

  it('malformed tool-call arguments throw BAD_RESPONSE (never coerced)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
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
                      function: { name: 'write_file', arguments: '{not json' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        ),
      ),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GroqError);
    expect(err.code).toBe(GroqErrorCode.BAD_RESPONSE);
  });

  it('tool call missing name throws BAD_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          200,
          completionBody({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        ),
      ),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err.code).toBe(GroqErrorCode.BAD_RESPONSE);
  });
});

describe('GroqClient secrets', () => {
  it('error messages never leak the API key', async () => {
    const fakeKey = 'gsk_test_FAKEKEY_abcdef123456';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'invalid key' } })),
    );
    const client = new GroqClient({ apiKey: fakeKey, sleep: noSleep });
    const err = (await client
      .chatCompletions({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e)) as GroqError;
    expect(err.message).not.toContain(fakeKey);
    expect(err.message).not.toContain('abcdef123456');
    expect(String(err.stack ?? '')).not.toContain(fakeKey);
  });

  it('refuses empty apiKey at construction', () => {
    expect(() => new GroqClient({ apiKey: '' })).toThrow(GroqError);
  });
});

describe('GroqClient listModels', () => {
  it('returns model id strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, { data: [{ id: 'a' }, { id: 'b' }, { noId: true }] }),
      ),
    );
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    expect(await client.listModels()).toEqual(['a', 'b']);
  });

  it('throws BAD_RESPONSE when data is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: 'nope' })));
    const client = new GroqClient({ apiKey: 'gsk_test_key', sleep: noSleep });
    const err = await client.listModels().catch((e) => e);
    expect(err.code).toBe(GroqErrorCode.BAD_RESPONSE);
  });
});
