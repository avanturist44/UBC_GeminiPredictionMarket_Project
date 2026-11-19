import { LlmError } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createResponsesProvider } from '../src/llm/responses';
import { SCHEMA, failure, fakeFetch, hangingFetch, json, queued, request } from './fake-fetch';

const KEY = 'sk-test-0123456789abcdef';

const completed = (overrides: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-5-2025-08-07',
  output: [
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: '{"ok":', annotations: [] },
        { type: 'output_text', text: 'true}', annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 1200, output_tokens: 340, total_tokens: 1540 },
  ...overrides,
});

const gpt = (fetch: typeof globalThis.fetch) =>
  createResponsesProvider({ vendor: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, model: 'gpt-5', fetch });
const grok = (fetch: typeof globalThis.fetch) =>
  createResponsesProvider({ vendor: 'xai', baseUrl: 'https://api.x.ai/v1', apiKey: KEY, model: 'grok-4.7', fetch });

describe('createResponsesProvider', () => {
  it('sends the web_search tool only when asked, with at most five tool calls', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, completed()));
    const provider = gpt(fetch);
    await provider.complete(request({ useSearch: true }));
    await provider.complete(request({ useSearch: false }));

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-5', instructions: 'SYSTEM PROMPT', input: 'USER MESSAGE' });
    expect(calls[0]!.body.tools).toEqual([{ type: 'web_search' }]);
    expect(calls[0]!.body.max_tool_calls).toBe(5);
    expect(calls[0]!.body).not.toHaveProperty('max_turns');
    expect(calls[1]!.body).not.toHaveProperty('tools');
    expect(calls[1]!.body).not.toHaveProperty('max_tool_calls');
  });

  it("bounds xAI's search with max_turns, the field xAI documents, instead of max_tool_calls", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, completed({ model: 'grok-4.7' })));
    const provider = grok(fetch);
    await provider.complete(request({ useSearch: true }));
    await provider.complete(request({ useSearch: false }));

    expect(calls[0]!.body.tools).toEqual([{ type: 'web_search' }]);
    expect(calls[0]!.body.max_turns).toBe(5);
    expect(calls[0]!.body).not.toHaveProperty('max_tool_calls');
    expect(calls[1]!.body).not.toHaveProperty('max_turns');
  });

  it('caps every reply at 16,000 output tokens', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, completed()));
    const provider = gpt(fetch);
    await provider.complete(request({ useSearch: true }));
    await provider.complete(request({ useSearch: false }));
    expect(calls.map((call) => call.body.max_output_tokens)).toEqual([16_000, 16_000]);
  });

  it('returns output_text and usage input_tokens/output_tokens', async () => {
    const { fetch } = fakeFetch(() => json(200, completed()));
    expect(await gpt(fetch).complete(request({ useSearch: true }))).toEqual({
      text: '{"ok":true}',
      model: 'gpt-5-2025-08-07',
      usage: { inputTokens: 1200, outputTokens: 340 },
      searches: 1,
    });
  });

  it('counts web_search_call items, or the searches xAI reports in usage', async () => {
    const message = completed().output[1]!;
    const search = (id: string) => ({ type: 'web_search_call', id, status: 'completed' });
    const xaiUsage = {
      input_tokens: 32,
      output_tokens: 9,
      total_tokens: 41,
      num_server_side_tools_used: 4,
      server_side_tool_usage_details: { web_search_calls: 4, x_search_calls: 0 },
    };
    const { fetch } = queued([
      json(200, completed({ output: [search('ws_1'), search('ws_2'), search('ws_3'), message] })),
      json(200, completed({ output: [message], usage: xaiUsage })),
      json(200, completed({ output: [message] })),
    ]);
    const provider = gpt(fetch);
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(3);
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(4);
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(0);
  });

  it('counts the reasoning tokens xAI reports outside output_tokens', async () => {
    // xAI's own example: total_tokens = input + output + reasoning, so reasoning is not in output_tokens.
    const usage = { input_tokens: 32, output_tokens: 9, output_tokens_details: { reasoning_tokens: 110 }, total_tokens: 151 };
    const { fetch, calls } = fakeFetch(() => json(200, completed({ model: 'grok-4.7', usage })));
    const completion = await grok(fetch).complete(request({ useSearch: true }));
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/responses');
    expect(completion.model).toBe('grok-4.7');
    expect(completion.usage).toEqual({ inputTokens: 32, outputTokens: 119 });
  });

  it('asks for the json_schema text format', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, completed()));
    await gpt(fetch).complete(request({ useSearch: true }));
    expect(calls[0]!.body.text).toEqual({ format: { type: 'json_schema', name: 'reply', schema: SCHEMA, strict: true } });
  });

  it('sends the schema without the root $schema key', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, completed()));
    // What createLlm passes on is zod's own output, which starts with a $schema draft key.
    const zodSchema = z.toJSONSchema(z.object({ ok: z.boolean() }));
    expect(zodSchema).toHaveProperty('$schema');
    await gpt(fetch).complete(request({ jsonSchema: { ...zodSchema, $id: 'https://example.com/reply' } }));

    const sent = (calls[0]!.body.text as { format: { schema: Record<string, unknown> } }).format.schema;
    expect(sent).not.toHaveProperty('$schema');
    expect(sent).not.toHaveProperty('$id');
    // Everything else goes exactly as zod produced it.
    expect(sent).toEqual(SCHEMA);
  });

  it('maps 401 to unavailable and 429 to provider', async () => {
    const { fetch } = queued([
      json(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }),
      json(429, { error: { message: 'Rate limit reached for gpt-5.', type: 'requests', code: 'rate_limit_exceeded' } }),
      json(503, { error: { message: 'Service unavailable.' } }),
    ]);
    const provider = gpt(fetch);

    const rejected = await failure(provider.complete(request()));
    expect(rejected).toBeInstanceOf(LlmError);
    expect(rejected).toMatchObject({ code: 'unavailable' });
    expect(rejected!.message).toContain('401');
    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'provider' });
    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'provider' });
  });

  it('maps an account with no credit to unavailable, even on 429', async () => {
    const { fetch } = queued([
      // OpenAI: no credit is a 429 with code insufficient_quota.
      json(429, {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
      // xAI: the error is a plain string.
      json(429, { code: 'Too many requests', error: 'Your team has used all available credits or reached its spending limit.' }),
    ]);
    const provider = gpt(fetch);
    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'unavailable' });
    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'unavailable' });
  });

  it('never puts the key in an error message', async () => {
    const { fetch } = queued([
      json(401, { error: { message: `Incorrect API key provided: ${KEY}.`, code: 'invalid_api_key' } }),
      json(400, { code: 'Client specified an invalid argument', error: `Incorrect API key provided: ${KEY}` }),
      json(500, { error: { message: `upstream failed for ${KEY}` } }),
    ]);
    const provider = gpt(fetch);
    for (let i = 0; i < 3; i += 1) {
      const error = await failure(provider.complete(request({ useSearch: true })));
      expect(error).toBeInstanceOf(LlmError);
      expect(error!.message).not.toContain(KEY);
      expect(error!.message).not.toContain('SYSTEM PROMPT');
      expect(error!.message).not.toContain('USER MESSAGE');
    }

    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const unreachable = await failure(gpt(offline).complete(request()));
    expect(unreachable).toMatchObject({ code: 'provider' });
    expect(unreachable!.message).not.toContain(KEY);
  });

  it('reports a refusal or a filtered reply as refused, and a cut-off reply as a provider error', async () => {
    const refusal = completed({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
    });
    const { fetch } = queued([
      json(200, refusal),
      json(200, completed({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })),
      json(200, completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })),
    ]);
    const provider = gpt(fetch);

    // The tokens were still paid for, so the error carries them.
    expect(await failure(provider.complete(request()))).toMatchObject({
      code: 'refused',
      usage: { inputTokens: 1200, outputTokens: 340 },
    });
    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'refused' });
    const cut = await failure(provider.complete(request()));
    expect(cut).toMatchObject({ code: 'provider' });
    expect(cut!.message).toContain('max_output_tokens');
  });

  it('stops waiting after timeoutMs', async () => {
    expect(await failure(gpt(hangingFetch).complete(request({ timeoutMs: 20 })))).toMatchObject({ code: 'timeout' });
  });
});
