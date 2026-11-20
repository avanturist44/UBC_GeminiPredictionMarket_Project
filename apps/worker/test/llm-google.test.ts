import { DATA_RULE, LlmError, dataBlock } from '@thesis/core';
import { describe, expect, it } from 'vitest';
import { ANSWER_NOTE, RESEARCH_SYSTEM, createGoogleProvider } from '../src/llm/google';
import { SCHEMA, failure, fakeFetch, hangingFetch, json, queued, request } from './fake-fetch';

const KEY = 'AIzaTest0123456789abcdef';
const SUGGESTIONS = '<style>.chip{}</style><div class="chip"><a href="https://www.google.com/search?q=brent">brent</a></div>';

/** A reply to a request without search: the JSON answer, as one generateContent reply. */
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

const RESEARCH_TEXT = 'Brent settled at $91.20 on Tuesday, and OPEC kept its output unchanged.';

/** The research step's reply: prose, grounded by the searches in `webSearchQueries`, or not grounded. */
const researched = (grounding: Record<string, unknown> | null = {}, overrides: Record<string, unknown> = {}) => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'Searching for the price.', thought: true }, { text: RESEARCH_TEXT }] },
      finishReason: 'STOP',
      ...(grounding === null
        ? {}
        : {
            groundingMetadata: {
              webSearchQueries: ['brent price today', 'opec output november'],
              searchEntryPoint: { renderedContent: SUGGESTIONS },
              groundingChunks: [
                { web: { uri: 'https://example.com/brent', title: 'example.com' } },
                { retrievedContext: { uri: 'gs://not-a-web-page' } },
                { web: { uri: 'https://news.example/opec', title: 'news.example' } },
              ],
              ...grounding,
            },
          }),
    },
  ],
  usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 200, toolUsePromptTokenCount: 1000, thoughtsTokenCount: 50 },
  modelVersion: 'gemini-3.1-pro-preview',
  ...overrides,
});

/** The answer step's reply: the JSON object, with no search of its own. */
const answered = (overrides: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 100 },
  modelVersion: 'gemini-3.1-pro-preview-11-2026',
  ...overrides,
});

const gemini = (fetch: typeof globalThis.fetch) => createGoogleProvider({ apiKey: KEY, model: 'gemini-2.5-pro', fetch });
/** The text of a request's system instruction or of its one user turn. */
const textOf = (body: Record<string, unknown>, field: 'systemInstruction' | 'contents') => {
  const value = body[field] as { parts: Array<{ text: string }> } | Array<{ parts: Array<{ text: string }> }>;
  return (Array.isArray(value) ? value[0]! : value).parts[0]!.text;
};

describe('createGoogleProvider', () => {
  it('a search call researches first, then answers from the research without searching', async () => {
    const { fetch, calls } = queued([json(200, researched()), json(200, answered())]);
    const completion = await gemini(fetch).complete(request({ useSearch: true }));

    expect(calls).toHaveLength(2);
    const [research, answer] = calls;
    expect(research!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(research!.headers.get('x-goog-api-key')).toBe(KEY);
    // Research: the question, Google Search, and a prose reply (no JSON mode).
    expect(research!.body).toEqual({
      systemInstruction: { parts: [{ text: `${RESEARCH_SYSTEM}\n\n${DATA_RULE}` }] },
      contents: [{ role: 'user', parts: [{ text: 'USER MESSAGE' }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 16_000 },
    });
    expect(textOf(research!.body, 'systemInstruction').startsWith(RESEARCH_SYSTEM)).toBe(true);

    // Answer: the caller's own prompt, no tools, JSON mode, and the research with the sources it read.
    expect(answer!.url).toBe(research!.url);
    expect(answer!.body).not.toHaveProperty('tools');
    expect(answer!.body.systemInstruction).toEqual({ parts: [{ text: 'SYSTEM PROMPT' }] });
    expect(answer!.body.generationConfig).toEqual({
      maxOutputTokens: 16_000,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
    });
    const notes = `${RESEARCH_TEXT}\n\nSources read:\n[1] example.com: https://example.com/brent\n[2] news.example: https://news.example/opec`;
    expect(textOf(answer!.body, 'contents')).toBe(`USER MESSAGE\n\n${dataBlock('research', notes)}\n\n${ANSWER_NOTE}`);
    // The research's thought parts are its working, not its findings.
    expect(textOf(answer!.body, 'contents')).not.toContain('Searching for the price.');

    expect(completion).toEqual({
      text: '{"ok":true}',
      model: 'gemini-3.1-pro-preview-11-2026',
      // 300 + 1,000 in and 200 + 50 out for the research, then 1,500 in and 100 out.
      usage: { inputTokens: 2800, outputTokens: 350 },
      searches: 2,
      searchSuggestionsHtml: SUGGESTIONS,
    });
  });

  it('research that ran no search ends the call without an answer', async () => {
    const { fetch, calls } = queued([json(200, researched(null)), json(200, answered())]);
    const completion = await gemini(fetch).complete(request({ useSearch: true }));
    expect(calls).toHaveLength(1);
    expect(completion).toEqual({
      text: '',
      model: 'gemini-3.1-pro-preview',
      usage: { inputTokens: 1300, outputTokens: 250 },
      searches: 0,
    });
  });

  it('a failed answer keeps the research tokens', async () => {
    const spent = { inputTokens: 1300, outputTokens: 250 };
    const [answer] = answered().candidates;
    const cases: Array<[Response, string, { inputTokens: number; outputTokens: number }]> = [
      [json(500, { error: { code: 500, message: `Internal error for ${KEY}.`, status: 'INTERNAL' } }), 'provider', spent],
      // The answer came back, so its own tokens count too.
      [json(200, answered({ candidates: [{ ...answer, finishReason: 'SAFETY' }] })), 'refused', { inputTokens: 2800, outputTokens: 350 }],
      [json(200, answered({ candidates: [{ ...answer, finishReason: 'MAX_TOKENS' }] })), 'provider', { inputTokens: 2800, outputTokens: 350 }],
    ];
    for (const [reply, code, usage] of cases) {
      const error = await failure(gemini(queued([json(200, researched()), reply]).fetch).complete(request({ useSearch: true })));
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ code, usage });
      expect(error!.message).not.toContain(KEY);
    }

    // The answer never arrives.
    let sent = 0;
    const slow = ((url: string | URL | Request, init?: RequestInit) =>
      sent++ === 0 ? Promise.resolve(json(200, researched())) : hangingFetch(url, init)) as typeof globalThis.fetch;
    expect(await failure(gemini(slow).complete(request({ useSearch: true, timeoutMs: 50 })))).toMatchObject({
      code: 'timeout',
      usage: spent,
    });
  });

  it('a call without search is one request, as before', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, grounded()));
    await gemini(fetch).complete(request({ useSearch: false }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: 'SYSTEM PROMPT' }] },
      contents: [{ role: 'user', parts: [{ text: 'USER MESSAGE' }] }],
      generationConfig: { maxOutputTokens: 16_000, responseMimeType: 'application/json', responseJsonSchema: SCHEMA },
    });
  });

  it('asks Gemini for JSON in its own structured-output mode, and never while it searches', async () => {
    const { fetch, calls } = queued([
      json(200, grounded()),
      json(200, grounded()),
      json(200, researched()),
      json(200, answered()),
      json(200, researched()),
      json(200, answered()),
    ]);
    const provider = gemini(fetch);
    expect(provider.enforcesJsonSchema).toBe(true);
    await provider.complete(request({ jsonSchema: SCHEMA }));
    await provider.complete(request({ jsonSchema: undefined }));
    await provider.complete(request({ useSearch: true, jsonSchema: SCHEMA }));
    await provider.complete(request({ useSearch: true, jsonSchema: undefined }));
    const jsonMode = { maxOutputTokens: 16_000, responseMimeType: 'application/json', responseJsonSchema: SCHEMA };
    const plain = { maxOutputTokens: 16_000 };
    expect(calls.map((call) => call.body.generationConfig)).toEqual([jsonMode, plain, plain, jsonMode, plain, plain]);
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

    const completion = await provider.complete(request());
    // Thought parts are the model's working, not its answer.
    expect(completion).toMatchObject({ text: '{"ok":true}', model: 'gemini-2.5-pro' });
    expect(completion.usage).toEqual({ inputTokens: 800, outputTokens: 120 });
    // Thinking is billed as output and search results as input, so both are counted.
    expect((await provider.complete(request())).usage).toEqual({ inputTokens: 1250, outputTokens: 420 });
  });

  it('returns the research’s searchEntryPoint.renderedContent as searchSuggestionsHtml', async () => {
    const { fetch } = queued([json(200, researched()), json(200, answered()), json(200, researched(null))]);
    const provider = gemini(fetch);

    expect((await provider.complete(request({ useSearch: true }))).searchSuggestionsHtml).toBe(SUGGESTIONS);
    expect(await provider.complete(request({ useSearch: true }))).not.toHaveProperty('searchSuggestionsHtml');
  });

  it('counts each Gemini search query the research ran', async () => {
    const { fetch } = queued([
      json(200, researched({ webSearchQueries: ['brent price today', 'opec output november', 'brent futures curve'] })),
      json(200, answered()),
      json(200, researched({ webSearchQueries: undefined })),
      json(200, answered()),
      json(200, researched({ webSearchQueries: [] })),
      json(200, answered()),
      json(200, researched(null)),
    ]);
    const provider = gemini(fetch);

    // Gemini 3 bills each query it ran.
    expect((await provider.complete(request({ useSearch: true }))).searches).toBe(3);
    // Research that was grounded but does not list its queries ran at least one.
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

  it('a free-tier quota of zero is unavailable, not a rate limit', async () => {
    const { fetch } = fakeFetch(() =>
      json(429, {
        error: {
          code: 429,
          message: `You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro ${KEY}`,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      }),
    );
    const error = await failure(gemini(fetch).complete(request({ useSearch: true })));
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error!.message).toMatch(/quota|billing/i);
    expect(error!.message).not.toContain(KEY);
  });

  it('a per-minute rate limit is still a provider error', async () => {
    const { fetch } = fakeFetch(() =>
      json(429, {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }],
        },
      }),
    );
    expect(await failure(gemini(fetch).complete(request({ useSearch: true })))).toMatchObject({
      code: 'provider',
      rateLimited: true,
    });
  });

  it('stops waiting after timeoutMs', async () => {
    expect(await failure(gemini(hangingFetch).complete(request({ timeoutMs: 20 })))).toMatchObject({ code: 'timeout' });
  });
});
