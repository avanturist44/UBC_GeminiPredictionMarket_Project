import type { BookTicker } from '@thesis/core';
import { asc, eq, markets, pricePoints, upsertMarket, type Db, type MarketUpsert } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQuoteRecorder, type QuoteRecorder } from '../src/quotes';

const SYMBOL = 'GEMI-BTC15M2611180315-UP';
const KEY = 'gemi-btc15m2611180315-up';

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: SYMBOL,
  eventTicker: 'BTC15M2611180315',
  contractTicker: 'UP',
  title: 'BTC price today at 10:15pm EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: new Date('2026-11-18T03:15:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '64931.38',
  yesBid: '0.50',
  yesAsk: '0.60',
  lastPrice: null,
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

const ticker = (overrides: Partial<BookTicker> = {}): BookTicker => ({
  symbolKey: KEY,
  bid: '0.8900',
  bidSize: '5.00',
  ask: '0.9500',
  askSize: '10.00',
  last: '0.8300',
  ...overrides,
});

let db: Db;
let close: () => Promise<void>;
let now: Date;
let marketId: string;
let quotes: QuoteRecorder;
const errors: string[] = [];

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18, 3, 5, seconds));
const points = () => db.select().from(pricePoints).orderBy(asc(pricePoints.ts));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  errors.length = 0;
  now = at(0);
  ({ id: marketId } = await upsertMarket(db, market()));
  quotes = createQuoteRecorder({
    db,
    now: () => now,
    logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
  });
  quotes.setMarkets([{ id: marketId, instrumentSymbol: SYMBOL }]);
});
afterEach(() => close());

describe('createQuoteRecorder', () => {
  it('writes the first quote of a symbol at the next flush', async () => {
    quotes.handle(ticker());
    expect(await points()).toHaveLength(0);
    expect(await quotes.flush()).toBe(1);

    const [point] = await points();
    expect(point).toMatchObject({
      marketId,
      yesBid: '0.8900',
      yesAsk: '0.9500',
      lastPrice: '0.8300',
      source: 'ws',
    });
    expect(point!.ts.toISOString()).toBe(at(0).toISOString());
    const [row] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(row).toMatchObject({ yesBid: '0.8900', yesAsk: '0.9500', lastPrice: '0.8300' });
  });

  it('writes at most one row per symbol every 10 seconds, and the newest quote wins', async () => {
    quotes.handle(ticker());
    await quotes.flush();

    now = at(3);
    quotes.handle(ticker({ bid: '0.9000' }));
    now = at(6);
    quotes.handle(ticker({ bid: '0.9100' }));
    expect(await quotes.flush()).toBe(0);
    // No new price point yet, but the market already shows the newest quote.
    const [shown] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(shown).toMatchObject({ yesBid: '0.9100', yesAsk: '0.9500' });
    expect(await points()).toHaveLength(1);
    now = at(9);
    expect(await quotes.flush()).toBe(0);

    // Ten seconds after the last write the waiting quote goes out, even with no new message.
    now = at(10);
    expect(await quotes.flush()).toBe(1);
    const rows = await points();
    expect(rows.map((p) => [p.ts.toISOString(), p.yesBid])).toEqual([
      [at(0).toISOString(), '0.8900'],
      [at(10).toISOString(), '0.9100'],
    ]);
    expect(await quotes.flush()).toBe(0);
  });

  it('does not write again when only the sizes changed', async () => {
    quotes.handle(ticker());
    await quotes.flush();
    now = at(20);
    quotes.handle(ticker({ bidSize: '7.00', askSize: '1.00' }));
    expect(await quotes.flush()).toBe(0);
    expect(await points()).toHaveLength(1);
  });

  it('does not write when the price went away and came back within the window', async () => {
    quotes.handle(ticker());
    await quotes.flush();
    now = at(2);
    quotes.handle(ticker({ bid: '0.5000' }));
    now = at(4);
    quotes.handle(ticker());
    now = at(15);
    expect(await quotes.flush()).toBe(0);
  });

  it('throttles each symbol on its own', async () => {
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-ETH15M2611180315-UP' }));
    quotes.setMarkets([
      { id: marketId, instrumentSymbol: SYMBOL },
      { id: other.id, instrumentSymbol: 'GEMI-ETH15M2611180315-UP' },
    ]);
    quotes.handle(ticker());
    await quotes.flush();
    now = at(5);
    quotes.handle(ticker({ bid: '0.9000' }));
    quotes.handle(ticker({ symbolKey: 'gemi-eth15m2611180315-up', bid: '0.1000', ask: '0.2000' }));
    expect(await quotes.flush()).toBe(1);
    const rows = await points();
    expect(rows.map((p) => p.marketId)).toEqual([marketId, other.id]);
  });

  it('ignores a symbol that is not tracked', async () => {
    quotes.handle(ticker({ symbolKey: 'gemi-unknown-x' }));
    expect(await quotes.flush()).toBe(0);
    expect(await points()).toHaveLength(0);
  });

  it('forgets a symbol once it is no longer tracked', async () => {
    quotes.handle(ticker());
    quotes.setMarkets([]);
    expect(await quotes.flush()).toBe(0);
    expect(await points()).toHaveLength(0);
  });

  it('clears the market’s quote when the book empties, without a price point', async () => {
    quotes.handle(ticker({ last: null }));
    await quotes.flush();
    now = at(10);
    quotes.handle(ticker({ bid: null, bidSize: null, ask: null, askSize: null, last: null }));
    expect(await quotes.flush()).toBe(0);
    expect(await points()).toHaveLength(1);
    const [row] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(row).toMatchObject({ yesBid: null, yesAsk: null });
  });

  it('writes the refilled quote at once after a momentary empty book', async () => {
    quotes.handle(ticker({ last: null }));
    await quotes.flush();
    // The market maker pulls its quotes for an instant, just as a flush runs.
    now = at(10);
    quotes.handle(ticker({ bid: null, bidSize: null, ask: null, askSize: null, last: null }));
    await quotes.flush();
    now = at(11);
    quotes.handle(ticker({ bid: '0.8800', last: null }));
    expect(await quotes.flush()).toBe(1);
    const [row] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(row).toMatchObject({ yesBid: '0.8800', yesAsk: '0.9500' });
    expect(await points()).toHaveLength(2);
  });

  it('keeps a quote it could not write, and tries again after the usual wait, not every second', async () => {
    // A market id that does not exist makes the write fail.
    quotes.setMarkets([{ id: '00000000-0000-4000-8000-000000000000', instrumentSymbol: SYMBOL }]);
    quotes.handle(ticker());
    expect(await quotes.flush()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(SYMBOL);

    now = at(1);
    expect(await quotes.flush()).toBe(0);
    expect(errors).toHaveLength(1);

    now = at(10);
    expect(await quotes.flush()).toBe(0);
    expect(errors).toHaveLength(2);
    expect(await points()).toHaveLength(0);
  });

  it('does not touch the market again while the quote is unchanged', async () => {
    quotes.handle(ticker());
    await quotes.flush();
    now = at(2);
    quotes.handle(ticker({ bid: '0.9000' }));
    await quotes.flush();
    const [before] = await db.select().from(markets).where(eq(markets.id, marketId));
    now = at(3);
    quotes.handle(ticker({ bid: '0.9000', bidSize: '9.00' }));
    await quotes.flush();
    const [after] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
  });

  it('counts what it has written', async () => {
    quotes.handle(ticker());
    await quotes.flush();
    expect(quotes.stats()).toEqual({ written: 1, tracked: 1 });
  });
});
