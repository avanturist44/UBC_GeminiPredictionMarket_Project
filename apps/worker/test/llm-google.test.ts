import { LlmError } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { createGoogleProvider } from '../src/llm/google';
import { failure, fakeFetch, hangingFetch, json, queued, request } from './fake-fetch';

const KEY = 'AIzaTest0123456789abcdef';
const SUGGESTIONS = '<style>.chip{}</style><div class="chip"><a href="https://www.google.com/search?q=brent">brent</a></div>';

const grounded = (overrides: Record<string, unknown> = {}) => ({
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Looking at the oil price first.', thought: true }, { text: '{"ok":' }, { text: 'true}' }],
      },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['brent price today'],
        searchEntryPoint: { renderedContent: SUGGESTIONS },
        groundingChunks: [{ web: { uri: 'https://example.com/brent', title: 'example.com' } }],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120, totalTokenCount: 920 },
  modelVersion: 'gemini-2.5-pro',
  ...overrides,
});

const gemini = (fetch: typeof globalThis.fetch) => createGoogleProvider({ apiKey: KEY, model: 'gemini-2.5-pro', fetch });

describe('createGoogleProvider', () => {
  it('sends tools: [{ google_search: {} }] when asked', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, grounded()));
    const provider = gemini(fetch);
    await provider.complete(request({ useSearch: true }));
    await provider.complete(request({ useSearch: false }));

    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(KEY);
    expect(calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: 'SYSTEM PROMPT' }] },
      contents: [{ role: 'user', parts: [{ text: 'USER MESSAGE' }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 16_000 },
    });
    expect(calls[1]!.body).not.toHaveProperty('tools');
    // Only the output cap: no responseSchema, the shape comes from the JSON rule in the system prompt.
    expect(calls[1]!.body.generationConfig).toEqual({ maxOutputTokens: 16_000 });
  });

  it('reads usageMetadata.promptTokenCount and candidatesTokenCount', async () => {
    const thinking = grounded({
      usageMetadata: {
        promptTokenCount: 800,
        candidatesTokenCount: 120,
        thoughtsTokenCount: 300,
        toolUsePromptTokenCount: 450,
        totalTokenCount: 1670,
      },
    });
    const { fetch } = queued([json(200, grounded()), json(200, thinking)]);
    const provider = gemini(fetch);

    const completion = await provider.complete(request({ useSearch: true }));
    // Thought parts are the model's working, not its answer.
    expect(completion).toMatchObject({ text: '{"ok":true}', model: 'gemini-2.5-pro' });
    expect(completion.usage).toEqual({ inputTokens: 800, outputTokens: 120 });
    // Thinking is billed as output and search results as input, so both are counted.
    expect((await provider.complete(request({ useSearch: true }))).usage).toEqual({ inputTokens: 1250, outputTokens: 420 });
  });

  it('returns groundingMetadata.searchEntryPoint.renderedContent as searchSuggestionsHtml', async () => {
    const [first] = grounded().candidates;
    const ungrounded = grounded({ candidates: [{ ...first, groundingMetadata: undefined }] });
    const { fetch } = queued([json(200, grounded()), json(200, ungrounded)]);
    const provider = gemini(fetch);

    expect((await provider.complete(request({ useSearch: true }))).searchSuggestionsHtml).toBe(SUGGESTIONS);
    expect(await provider.complete(request({ useSearch: true }))).not.toHaveProperty('searchSuggestionsHtml');
  });

  it('counts each Gemini search query', async () => {
    const [first] = grounded().candidates;
    const withQueries = (webSearchQueries?: string[]) =>
      grounded({ candidates: [{ ...first, groundingMetadata: { ...first!.groundingMetadata, webSearchQueries } }] });
    const ungrounded = grounded({ candidates: [{ ...first, groundingMetadata: undefined }] });
    const { fetch } = queued([
      json(200, withQueries(['brent price today', 'opec output november', 'brent futures curve'])),
      json(200, withQueries(undefined)),
      json(200, withQueries([])),
      json(200, ungrounded),
    ]);
    const provider = gemini(fetch);

    // Gemini 3 bills each query it ran.
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(3);
    // A grounded answer that does not list its queries ran at least one.
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(1);
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(1);
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(0);
  });

  it('reports a blocked prompt or a safety stop as refused, and a cut-off reply as a provider error', async () => {
    const [first] = grounded().candidates;
    const { fetch } = queued([
      json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 50 } }),
      json(200, grounded({ candidates: [{ ...first, finishReason: 'SAFETY' }] })),
      json(200, grounded({ candidates: [{ ...first, finishReason: 'MAX_TOKENS' }] })),
    ]);
    const provider = gemini(fetch);

    expect(await failure(provider.complete(request()))).toMatchObject({ code: 'refused' });
    expect(await failure(provider.complete(request()))).toMatchObject({
      code: 'refused',
      usage: { inputTokens: 800, outputTokens: 120 },
    });
    const cut = await failure(provider.complete(request()));
    expect(cut).toMatchObject({ code: 'provider' });
    expect(cut!.message).toContain('MAX_TOKENS');
  });

  it('maps errors by status and never puts the key in the message', async () => {
    const { fetch, calls } = queued([
      json(400, { error: { code: 400, message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT' } }),
      json(403, { error: { code: 403, message: 'Permission denied.', status: 'PERMISSION_DENIED' } }),
      json(429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
      json(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }),
    ]);
    const provider = gemini(fetch);

    const codes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const error = await failure(provider.complete(request({ useSearch: true })));
      expect(error).toBeInstanceOf(LlmError);
      expect(error!.message).not.toContain(KEY);
      expect(error!.message).not.toContain('SYSTEM PROMPT');
      expect(error!.message).not.toContain('USER MESSAGE');
      codes.push(error!.code);
    }
    // A per-minute rate limit is a 429 too, so a 429 is worth trying again later.
    expect(codes).toEqual(['unavailable', 'unavailable', 'provider', 'provider']);
    // The key travels in a header, never in the address.
    expect(calls[0]!.url).not.toContain(KEY);
  });

  it('stops waiting after timeoutMs', async () => {
    expect(await failure(gemini(hangingFetch).complete(request({ timeoutMs: 20 })))).toMatchObject({ code: 'timeout' });
  });
});
