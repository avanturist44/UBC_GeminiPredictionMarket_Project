import { describe, expect, it } from 'vitest';
import {
  GeminiHttpError,
  GeminiParseError,
  createGeminiPublicClient,
  type GeminiPublicClientOptions,
} from '../src/index';
import { fixture } from './helpers';

type Reply = { status: number; body: unknown };

/** A fake fetch plus a fake clock: sleep() advances time instead of waiting. */
function harness(replies: Reply[], extra: Partial<GeminiPublicClientOptions> = {}) {
  let time = 1_000_000;
  const calls: Array<{ url: string; at: number }> = [];
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push({ url: String(input), at: time });
    const reply = queue.shift();
    if (!reply) throw new Error('no reply queued');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const client = createGeminiPublicClient({
    baseUrl: 'https://gemini.test/',
    fetch: fetchImpl,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    logger: { warn: (message) => warnings.push(message) },
    ...extra,
  });
  return { client, calls, warnings, sleeps };
}

const liveEvent = () => fixture('event-15m-live.json');

describe('createGeminiPublicClient', () => {
  it('fetches and parses one event', async () => {
    const { client, calls } = harness([{ status: 200, body: liveEvent() }]);
    const event = await client.getEvent('ETH15M2611170745');
    expect(event?.contracts[0]?.prices?.bestAsk).toBe('0.29');
    expect(calls.map((c) => c.url)).toEqual([
      'https://gemini.test/v1/prediction-markets/events/ETH15M2611170745',
    ]);
  });

  it('returns null for an event that does not exist', async () => {
    const { client } = harness([{ status: 404, body: { error: 'Event not found' } }]);
    expect(await client.getEvent('NOPE')).toBeNull();
  });

  it('builds the list query from documented parameters only', async () => {
    const { client, calls } = harness([{ status: 200, body: fixture('events-list-sample.json') }]);
    const list = await client.listEvents({ status: 'active', category: 'Crypto', limit: 50, offset: 100 });
    expect(list.data).toHaveLength(4);
    expect(calls[0]?.url).toBe(
      'https://gemini.test/v1/prediction-markets/events?status=active&category=Crypto&limit=50&offset=100',
    );
  });

  it('fetches the strike and recently settled events', async () => {
    const { client, calls } = harness([
      { status: 200, body: fixture('strike-ready.json') },
      { status: 200, body: fixture('recently-settled-sample.json') },
    ]);
    expect((await client.getStrike('ETH15M2611170745'))?.value).toBe('1830.11');
    expect((await client.listRecentlySettled()).data).toHaveLength(4);
    expect(calls.map((c) => c.url)).toEqual([
      'https://gemini.test/v1/prediction-markets/events/ETH15M2611170745/strike',
      'https://gemini.test/v1/prediction-markets/events/recently-settled',
    ]);
  });

  it('spaces requests at least two seconds apart', async () => {
    const { client, calls } = harness([
      { status: 200, body: liveEvent() },
      { status: 200, body: liveEvent() },
      { status: 200, body: liveEvent() },
    ]);
    await client.getEvent('A');
    await client.getEvent('B');
    await client.getEvent('C');
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(gaps).toEqual([2000, 2000]);
  });

  it('queues concurrent requests instead of sending them together', async () => {
    const { client, sleeps } = harness([
      { status: 200, body: liveEvent() },
      { status: 200, body: liveEvent() },
      { status: 200, body: liveEvent() },
    ]);
    await Promise.all([client.getEvent('A'), client.getEvent('B'), client.getEvent('C')]);
    // The first goes at once. The second reserves the slot 2 seconds out and the third the
    // slot 4 seconds out; the fake clock has already moved 2 seconds when the third asks.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('retries once on 429', async () => {
    const { client, calls } = harness([
      { status: 429, body: { error: 'rate limited' } },
      { status: 200, body: liveEvent() },
    ]);
    expect((await client.getEvent('A'))?.ticker).toBe('ETH15M2611170745');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBe(2000);
  });

  it('retries once on 5xx, then gives up with the status', async () => {
    const { client, calls } = harness([
      { status: 503, body: {} },
      { status: 500, body: { error: 'boom' } },
      { status: 200, body: liveEvent() },
    ]);
    const error = await client.getEvent('A').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect((error as GeminiHttpError).status).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it('does not retry other client errors', async () => {
    const { client, calls } = harness([
      { status: 400, body: { error: 'bad' } },
      { status: 200, body: liveEvent() },
    ]);
    await expect(client.listEvents({})).rejects.toBeInstanceOf(GeminiHttpError);
    expect(calls).toHaveLength(1);
  });

  it('throws a parse error when the body does not match the schema', async () => {
    const { client } = harness([{ status: 200, body: { ticker: 'A' } }]);
    await expect(client.getEvent('A')).rejects.toBeInstanceOf(GeminiParseError);
  });

  it('logs an unknown field once and still returns the event', async () => {
    const withNew = { ...(liveEvent() as object), brandNewField: true };
    const { client, warnings } = harness([
      { status: 200, body: withNew },
      { status: 200, body: withNew },
    ]);
    expect((await client.getEvent('A'))?.ticker).toBe('ETH15M2611170745');
    await client.getEvent('A');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('event.brandNewField');
  });

  it('aborts a request that exceeds the timeout', async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const { client } = harness([], { fetch: hanging, timeoutMs: 20 });
    await expect(client.getEvent('A')).rejects.toThrow();
  });
});
