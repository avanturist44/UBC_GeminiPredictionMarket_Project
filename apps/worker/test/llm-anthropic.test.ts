import { LlmError } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { failure, fakeFetch, hangingFetch, json, queued, request } from './fake-fetch';

const KEY = 'sk-test-0123456789abcdef';
const DEEPSEEK_SEARCH = { type: 'deepseek_web_search', name: 'deepseek_web_search' };

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-flash',
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'deepseek_web_search', input: { queries: ['brent price'] } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
    { type: 'text', text: '{"ok":true}' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
  ...overrides,
});

/** A Claude reply whose request ran `count` searches and stopped for `stop`. */
const searched = (count: number, stop: string) =>
  message({
    model: 'claude-sonnet-5-5',
    stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: count, web_fetch_requests: 0 } },
  });

/**
 * A Claude reply that ends its turn asking for `web_fetch`, a client tool it was never given,
 * after running `count` searches.
 */
const stray = (count: number) =>
  message({
    model: 'claude-sonnet-5-5',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I will open the agency report.' },
      { type: 'tool_use', id: 'toolu_stray_1', name: 'web_fetch', input: { url: 'https://example.com/agency-report' } },
    ],
    usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: count, web_fetch_requests: 0 } },
  });

const STRAY_REPLY = 'Only web search is available here. Reply now with the JSON object.';

/** An API error the SDK does not retry, so a test sees exactly the requests sent. */
const apiError = (status: number, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
  });

/** A logger that keeps its warnings. */
const warnings = () => {
  const seen: string[] = [];
  return { seen, logger: { warn: (m: string) => void seen.push(m) } };
};

describe('createAnthropicProvider', () => {
  it('answers a stray client tool call with an error and finishes', async () => {
    const answer = message({
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 200, output_tokens: 20, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    });
    const { fetch, calls } = queued([json(200, stray(2)), json(200, answer)]);
    const { seen, logger } = warnings();
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger, fetch });

    const completion = await claude.complete(request({ useSearch: true }));
    expect(completion).toEqual({
      text: '{"ok":true}',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 300, outputTokens: 30 },
      searches: 3,
    });

    expect(calls).toHaveLength(2);
    const sent = calls[1]!.body.messages as Array<{ role: string; content: unknown }>;
    // The question, the model's own reply as it came, then one error result for its tool call.
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: 'user', content: 'USER MESSAGE' });
    expect(sent[1]).toEqual({ role: 'assistant', content: stray(2).content });
    expect(sent[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_stray_1', is_error: true, content: STRAY_REPLY }],
    });
    // The continuation still offers only web search, with what is left of the call's five.
    expect(calls[1]!.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);

    // One warning, naming the tool and nothing the model wrote.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('web_fetch');
    expect(seen[0]).not.toContain('agency-report');
    expect(seen[0]).not.toContain('I will open');
  });

  it('answers every stray tool call in a reply, in one user message', async () => {
    const twoTools = message({
      model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_a', name: 'web_fetch', input: { url: 'https://example.com/a' } },
        { type: 'tool_use', id: 'toolu_b', name: 'bash', input: { command: 'ls' } },
      ],
      usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } },
    });
    const { fetch, calls } = queued([json(200, twoTools), json(200, message({ model: 'claude-sonnet-5-5' }))]);
    const { seen, logger } = warnings();
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger, fetch });

    await claude.complete(request({ useSearch: true }));
    const sent = calls[1]!.body.messages as Array<{ role: string; content: Array<{ tool_use_id: string }> }>;
    expect(sent.at(-1)!.content.map((block) => block.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('web_fetch');
    expect(seen[0]).toContain('bash');
    expect(seen[0]).not.toContain('ls');
  });

  it('gives up on repeated stray tool calls', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, stray(0)));
    const { logger } = warnings();
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger, fetch });

    const error = await failure(claude.complete(request({ useSearch: true })));
    // The first request and MAX_CONTINUATIONS (3) more, the same limit a paused search has.
    expect(calls).toHaveLength(4);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code: 'provider', usage: { inputTokens: 400, outputTokens: 40 } });
    expect(error!.message).toContain('tool_use');
  });

  it('a paused search and a stray tool call share the continuations and the five searches', async () => {
    const { fetch, calls } = queued([
      json(200, searched(2, 'pause_turn')),
      json(200, stray(2)),
      json(200, searched(1, 'end_turn')),
    ]);
    const { logger } = warnings();
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger, fetch });

    expect((await claude.complete(request({ useSearch: true }))).searches).toBe(5);
    expect(calls.map((call) => (call.body.tools as Array<{ max_uses?: number }>)[0]!.max_uses)).toEqual([5, 3, 1]);
    // Each request carries everything before it: nothing the model already did is dropped.
    const roles = (i: number) => (calls[i]!.body.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles(1)).toEqual(['user', 'assistant']);
    expect(roles(2)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });

  it('a continuation that fails still carries the tokens of the requests before it', async () => {
    const claude = (fetch: typeof globalThis.fetch) =>
      createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger: warnings().logger, fetch });
    const paid = { inputTokens: 100, outputTokens: 10 };

    // The API rejects the answer to a stray tool call: the 400 is sent once more without
    // fallbacks, as any 400 is, and then reported.
    const rejected = queued([json(200, stray(2)), apiError(400, 'unexpected tool_result'), apiError(400, 'unexpected tool_result')]);
    expect(await failure(claude(rejected.fetch).complete(request({ useSearch: true })))).toMatchObject({
      code: 'unavailable',
      usage: paid,
    });
    expect(rejected.calls).toHaveLength(3);

    // A resumed search that the server fails.
    const failed = queued([json(200, searched(2, 'pause_turn')), apiError(500, 'internal error')]);
    expect(await failure(claude(failed.fetch).complete(request({ useSearch: true })))).toMatchObject({
      code: 'provider',
      usage: paid,
    });

    // A continuation that never answers.
    let sent = 0;
    const slow = ((url: string | URL | Request, init?: RequestInit) =>
      sent++ === 0 ? Promise.resolve(json(200, stray(2))) : hangingFetch(url, init)) as typeof globalThis.fetch;
    expect(await failure(claude(slow).complete(request({ useSearch: true, timeoutMs: 20 })))).toMatchObject({
      code: 'timeout',
      usage: paid,
    });

    // A reply the adapter cannot read, after one it could.
    const garbled = queued([json(200, stray(2)), json(200, { ...stray(0), content: null })]);
    expect(await failure(claude(garbled.fetch).complete(request({ useSearch: true })))).toMatchObject({
      code: 'provider',
      usage: { inputTokens: 200, outputTokens: 20 },
    });
  });

  it('a first request that fails carries no usage: nothing was answered', async () => {
    const { fetch } = queued([apiError(500, 'internal error')]);
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, fetch });
    const error = await failure(claude.complete(request({ useSearch: true })));
    expect(error).toMatchObject({ code: 'provider' });
    expect(error!.usage).toBeUndefined();
  });

  it('stops answering stray tool calls once the call has used its five searches', async () => {
    const { fetch, calls } = queued([json(200, stray(5)), json(200, message({ model: 'claude-sonnet-5-5' }))]);
    const { logger } = warnings();
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, logger, fetch });

    const error = await failure(claude.complete(request({ useSearch: true })));
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ code: 'provider', usage: { inputTokens: 100, outputTokens: 10 } });
  });

  it('uses baseUrl and searchTool when given', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, message()));
    const deepseek = createAnthropicProvider({
      model: 'deepseek-flash',
      apiKey: KEY,
      baseUrl: 'https://api.deepseek.com/anthropic',
      searchTool: DEEPSEEK_SEARCH,
      fetch,
    });

    const completion = await deepseek.complete(request({ useSearch: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/);
    // The SDK sends the key as a bearer token, which DeepSeek's endpoint accepts.
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.tools).toEqual([DEEPSEEK_SEARCH]);
    // Server-side fallbacks are Anthropic's own beta: another endpoint is not sent it.
    expect(calls[0]!.body).not.toHaveProperty('fallbacks');
    expect(calls[0]!.headers.get('anthropic-beta')).toBeNull();
    // DeepSeek does not say how many searches it ran, so the most one call may run is counted.
    expect(completion).toEqual({
      text: '{"ok":true}',
      model: 'deepseek-flash',
      usage: { inputTokens: 540, outputTokens: 60 },
      searches: 5,
    });
  });

  it("uses Anthropic's web search and fallbacks when no endpoint is given", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, message({ model: 'claude-sonnet-5-5' })));
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, fetch });

    expect((await claude.complete(request({ useSearch: true }))).model).toBe('claude-sonnet-5-5');
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(calls[0]!.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(calls[0]!.body.fallbacks).toBe('default');
    expect(calls[0]!.body.max_tokens).toBe(16_000);
  });

  it('reports the searches each turn ran, from usage.server_tool_use', async () => {
    // A long search pauses once and is resumed: both turns' searches count.
    const { fetch, calls } = queued([json(200, searched(2, 'pause_turn')), json(200, searched(1, 'end_turn')), json(200, message())]);
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, fetch });

    expect((await claude.complete(request({ useSearch: true }))).searches).toBe(3);
    // The resumed request may run only what is left of the call's five searches.
    expect(calls.map((call) => (call.body.tools as Array<{ max_uses?: number }>)[0]!.max_uses)).toEqual([5, 3]);
    // A call that was not given search ran none.
    expect((await claude.complete(request({ useSearch: false }))).searches).toBe(0);
  });

  it('stops resuming a paused search once the call has used its five searches', async () => {
    const { fetch, calls } = queued([
      json(200, searched(3, 'pause_turn')),
      json(200, searched(2, 'pause_turn')),
      json(200, searched(0, 'end_turn')),
    ]);
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, fetch });

    const error = await failure(claude.complete(request({ useSearch: true })));
    // No third request: the paused answer is unfinished, so the call fails, with what it spent.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }]);
    expect(error).toMatchObject({ code: 'provider', usage: { inputTokens: 200, outputTokens: 20 } });
    expect(error!.message).toContain('pause_turn');
  });

  it('refuses another endpoint without its own key, so Anthropic credentials from the environment never reach it', () => {
    const create = () =>
      createAnthropicProvider({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', searchTool: DEEPSEEK_SEARCH });
    expect(create).toThrow(/apiKey/);
    expect(create).not.toThrow(LlmError);
    expect(() =>
      createAnthropicProvider({ model: 'deepseek-flash', apiKey: '', baseUrl: 'https://api.deepseek.com/anthropic' }),
    ).toThrow(/apiKey/);
  });

  it("maps DeepSeek's insufficient balance (402) to unavailable, without the key", async () => {
    const { fetch } = fakeFetch(() =>
      json(402, { type: 'error', error: { type: 'insufficient_balance', message: `Insufficient Balance for ${KEY}` } }),
    );
    const deepseek = createAnthropicProvider({
      model: 'deepseek-flash',
      apiKey: KEY,
      baseUrl: 'https://api.deepseek.com/anthropic',
      searchTool: DEEPSEEK_SEARCH,
      fetch,
    });

    const error = await failure(deepseek.complete(request({ useSearch: true })));
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error!.message).toContain('Insufficient Balance');
    expect(error!.message).not.toContain(KEY);
    expect(error!.message).not.toContain('SYSTEM PROMPT');
  });
});
