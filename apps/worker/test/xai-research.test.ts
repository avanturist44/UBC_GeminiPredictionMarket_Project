import { expect, it, vi } from 'vitest';
import { createXaiResearchProvider, parseXaiResearch, XaiResearchError } from '../src/xai-research';
import { evaluateNews, type NewsResearchRequest } from '../src/news';

const now = Date.parse('2026-11-18T20:00:00Z');
const context: NewsResearchRequest = { eventTicker: 'BTC2611182200', instrumentSymbol: 'GEMI-BTC2611182200-HI65000',
  title: 'BTC above 65,000', contractLabel: 'Above 65,000', description: 'Official description', rules: 'Official settlement rules',
  expiryAt: '2026-11-18T22:00:00Z', asOf: new Date(now).toISOString() };
const forecast = { probability_yes: .75, confidence: 'medium', headline: 'Public-evidence forecast', body: 'Fixture only.',
  no_trade_reason: null, evidence: [{ claim: 'Public report', url: 'https://example.org/report' },
    { claim: 'Official data', url: 'https://example.com/data' }] };
function response() {
  return { status: 'completed', model: 'grok-4.7', output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(forecast),
      annotations: forecast.evidence.map((e) => ({ type: 'url_citation', url: e.url, title: e.claim })) }] },
  ] };
}

it('uses bounded Grok web search and the shared strict JSON schema', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(response()), { status: 200 }));
  const provider = createXaiResearchProvider({ apiKey: 'test-only-key', fetch, now: () => now });
  const result = await provider.research(context, new AbortController().signal);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.x.ai/v1/responses');
  const init = fetch.mock.calls[0]?.[1];
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({ model: 'grok-4.7', store: false, max_tool_calls: 3, max_output_tokens: 2500,
    reasoning: { effort: 'low' },
    tools: [{ type: 'web_search' }], text: { format: { type: 'json_schema', strict: true, name: 'news_forecast' } } });
  expect(body.text.format.schema.additionalProperties).toBe(false);
  expect(body.text.format.schema.properties).not.toHaveProperty('side');
  expect(JSON.parse(body.input[1].content)).toEqual(context);
  expect(body.input[0].content).toContain('untrusted data');
  expect(result).toMatchObject({ provider: 'xai', model: 'grok-4.7', searchedAtMs: now, forecast });
  expect(result.sources).toHaveLength(2);
});

it('accepts provider citation metadata and never promotes model evidence URLs into retrieved sources', () => {
  const data = response(); data.output[1]!.content![0]!.annotations = [];
  const result = parseXaiResearch(data, now);
  expect(result.sources).toHaveLength(0);
  expect(evaluateNews({ nowMs: now, expiryMs: now + 3600_000, marketState: 'open',
    quote: { observedAtMs: now, bid: .48, ask: .5, bidSize: 10, askSize: 10 }, research: result }))
    .toMatchObject({ decision: 'skip', reason: 'citation missing from retrieved sources' });
  expect(parseXaiResearch({ ...data, citations: forecast.evidence.map((e) => e.url) }, now).sources).toHaveLength(2);
});

it('requires an actual completed search rather than citations alone', () => {
  const data = response(); data.output.shift();
  expect(() => parseXaiResearch(data, now)).toThrow('no completed web search');
  const failed = response(); failed.output[0]!.status = 'failed';
  expect(() => parseXaiResearch(failed, now)).toThrow('no completed web search');
});

it('rejects incomplete output, malformed JSON, model execution fields and refusals', () => {
  expect(() => parseXaiResearch({ ...response(), status: 'incomplete' }, now)).toThrow(XaiResearchError);
  const malformed = response(); malformed.output[1]!.content![0]!.text = 'not JSON';
  expect(() => parseXaiResearch(malformed, now)).toThrow('invalid forecast JSON');
  const order = response(); order.output[1]!.content![0]!.text = JSON.stringify({ ...forecast, quantity: 1000 });
  expect(() => parseXaiResearch(order, now)).toThrow('invalid forecast schema');
  const refusal = response(); refusal.output[1]!.content![0]!.type = 'refusal';
  expect(() => parseXaiResearch(refusal, now)).toThrow('model refusal');
});

it('does not expose upstream error bodies or the key in HTTP errors', async () => {
  const provider = createXaiResearchProvider({ apiKey: 'test-only-secret',
    fetch: async () => new Response('test-only-secret echoed by upstream', { status: 402 }) });
  const error = await provider.research(context, new AbortController().signal).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: 'XaiHttp402Error', status: 402 });
  expect(String(error)).not.toContain('test-only-secret');
});

it('forwards aborts and rejects malformed or oversized HTTP responses', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeDefined(); controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  await expect(createXaiResearchProvider({ apiKey: 'test-only', fetch }).research(context, controller.signal)).rejects.toThrow('Aborted');
  const malformed = createXaiResearchProvider({ apiKey: 'test-only', fetch: async () => new Response('not JSON') });
  await expect(malformed.research(context, new AbortController().signal)).rejects.toThrow('malformed response JSON');
  const oversized = createXaiResearchProvider({ apiKey: 'test-only',
    fetch: async () => new Response('{}', { headers: { 'content-length': '3000000' } }) });
  await expect(oversized.research(context, new AbortController().signal)).rejects.toThrow('response too large');
});
