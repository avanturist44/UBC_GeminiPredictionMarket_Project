import { LlmError } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { failure, fakeFetch, json, request } from './fake-fetch';

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
    expect(completion).toEqual({ text: '{"ok":true}', model: 'deepseek-flash', usage: { inputTokens: 540, outputTokens: 60 } });
  });

  it("uses Anthropic's web search and fallbacks when no endpoint is given", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, message({ model: 'claude-sonnet-5-5' })));
    const claude = createAnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: KEY, fetch });

    expect((await claude.complete(request({ useSearch: true }))).model).toBe('claude-sonnet-5-5');
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(calls[0]!.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(calls[0]!.body.fallbacks).toBe('default');
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
