import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventSchema, type GeminiEvent, type TrackedRule } from '@thesis/core';
import { asc, eq, markets, pricePoints, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRecorderCycle } from '../src/recorder';

const fixture = (name: string): GeminiEvent =>
  EventSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../packages/core/test/fixtures/${name}`, import.meta.url)),
        'utf8',
      ),
    ),
  );

const eth15: TrackedRule = {
  key: 'eth-15m',
  event: { kind: 'rolling', prefix: 'ETH15M', periodMinutes: 15, offsetMinutes: 0, count: 1 },
  pick: { kind: 'all' },
  keywords: [['ethereum']],
};
const btcDaily: TrackedRule = {
  key: 'btc-daily',
  event: { kind: 'fixed', ticker: 'BTC2611172200' },
  pick: { kind: 'nearestMoney', count: 1 },
  keywords: [['bitcoin']],
};
const fixed = (ticker: string): TrackedRule => ({
  key: ticker,
  event: { kind: 'fixed', ticker },
  pick: { kind: 'all' },
  keywords: [],
});

let db: Db;
let close: () => Promise<void>;
let time: Date;
const errors: string[] = [];
const logger = { info: () => {}, warn: () => {}, error: (message: string) => errors.push(message) };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  time = new Date('2026-11-17T07:31:00Z');
  errors.length = 0;
});
afterEach(() => close());

function run(rules: TrackedRule[], events: Record<string, GeminiEvent | Error | null>) {
  const requested: string[] = [];
  const client = {
    async getEvent(ticker: string) {
      requested.push(ticker);
      const reply = events[ticker] ?? null;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return runRecorderCycle({ db, client, rules, now: () => time, logger }).then((summary) => ({
    summary,
    requested,
  }));
}

const allMarkets = () => db.select().from(markets).orderBy(asc(markets.instrumentSymbol));
const allPoints = () => db.select().from(pricePoints).orderBy(asc(pricePoints.ts));

describe('runRecorderCycle', () => {
  it('stores a tracked contract and one price point from the event response', async () => {
    const { summary, requested } = await run([eth15], {
      ETH15M2611170745: fixture('event-15m-live.json'),
    });

    expect(requested).toEqual(['ETH15M2611170745']);
    expect(summary).toEqual({ events: 1, missing: 0, markets: 1, points: 1, errors: 0 });

    const [market] = await allMarkets();
    expect(market).toMatchObject({
      instrumentSymbol: 'GEMI-ETH15M2611170745-UP',
      eventTicker: 'ETH15M2611170745',
      contractTicker: 'UP',
      title: 'ETH price today at 2:45am EST',
      contractLabel: 'Up',
      category: 'Crypto',
      status: 'active',
      marketState: 'open',
      strike: '1830.11',
      yesBid: '0.2200',
      yesAsk: '0.2900',
      lastPrice: null,
      tracked: true,
      keywords: [['ethereum']],
      quantityIncrement: '0.01',
      quantityMinimum: '0.01',
      priceIncrement: '0.01',
      sourceDetails: { agency: 'lukka', index: 'LS-LRRR-ETHUSD' },
    });
    expect(market!.expiryAt?.toISOString()).toBe('2026-11-17T07:45:00.000Z');

    const [point] = await allPoints();
    expect(point).toMatchObject({
      marketId: market!.id,
      yesBid: '0.2200',
      yesAsk: '0.2900',
      lastPrice: null,
      source: 'rest',
    });
    expect(point!.ts.toISOString()).toBe('2026-11-17T07:31:00.000Z');
  });

  it('adds a point on each cycle without duplicating the market', async () => {
    const events = { ETH15M2611170745: fixture('event-15m-live.json') };
    await run([eth15], events);
    time = new Date('2026-11-17T07:31:30Z');
    await run([eth15], events);

    expect(await allMarkets()).toHaveLength(1);
    expect((await allPoints()).map((p) => p.ts.toISOString())).toEqual([
      '2026-11-17T07:31:00.000Z',
      '2026-11-17T07:31:30.000Z',
    ]);
  });

  it('stores the market but no price point when the book is empty', async () => {
    const { summary } = await run([fixed('BTC15M2611170745')], {
      BTC15M2611170745: fixture('event-15m-pending.json'),
    });
    expect(summary).toMatchObject({ markets: 1, points: 0 });
    const [market] = await allMarkets();
    expect(market).toMatchObject({ strike: null, yesBid: null, yesAsk: null });
    expect(await allPoints()).toHaveLength(0);
  });

  it('skips an event Gemini does not list and keeps going', async () => {
    const { summary } = await run([fixed('NOT-LISTED'), eth15], {
      ETH15M2611170745: fixture('event-15m-live.json'),
    });
    expect(summary).toEqual({ events: 2, missing: 1, markets: 1, points: 1, errors: 0 });
  });

  it('logs a failed request and still records the other events', async () => {
    const { summary } = await run([fixed('BROKEN'), eth15], {
      BROKEN: new Error('HTTP 500'),
      ETH15M2611170745: fixture('event-15m-live.json'),
    });
    expect(summary).toEqual({ events: 2, missing: 0, markets: 1, points: 1, errors: 1 });
    expect(errors.join('\n')).toContain('BROKEN');
  });

  it('keeps the first near-the-money contract after prices move', async () => {
    const daily = fixture('event-daily-categorical.json');
    await run([btcDaily], { BTC2611172200: daily });
    expect((await allMarkets()).map((m) => m.instrumentSymbol)).toEqual([
      'GEMI-BTC2611172200-HI64750',
    ]);

    // Bitcoin rallies: HI64750 is now deep in the money and HI66000 sits near 50 cents.
    const moved = structuredClone(daily);
    for (const contract of moved.contracts) {
      if (contract.ticker === 'HI64750') contract.prices = { bestBid: '0.90', bestAsk: '0.93' };
      if (contract.ticker === 'HI66000') contract.prices = { bestBid: '0.49', bestAsk: '0.51' };
    }
    time = new Date('2026-11-17T09:00:00Z');
    await run([btcDaily], { BTC2611172200: moved });

    const rows = await allMarkets();
    expect(rows.map((m) => m.instrumentSymbol)).toEqual(['GEMI-BTC2611172200-HI64750']);
    expect(rows[0]).toMatchObject({ yesBid: '0.9000', yesAsk: '0.9300' });
    expect(await allPoints()).toHaveLength(2);
  });

  it('never stores a resolution: that is the resolver’s write', async () => {
    await run([fixed('BTC15M2611170700')], {
      BTC15M2611170700: fixture('event-15m-settled.json'),
    });
    const [market] = await allMarkets();
    expect(market).toMatchObject({ status: 'settled', resolutionSide: null, resolvedAt: null });
    const rows = await db.select().from(markets).where(eq(markets.status, 'settled'));
    expect(rows).toHaveLength(1);
  });
});
