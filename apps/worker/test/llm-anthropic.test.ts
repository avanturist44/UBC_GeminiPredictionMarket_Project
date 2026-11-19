import { LlmError } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { failure, fakeFetch, json, queued, request } from './fake-fetch';

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

describe('createAnthropicProvider', () => {
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
