import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authors,
  getRecorderStatus,
  insertPricePoint,
  listTrackedSymbolsForEvent,
  markets,
  pricePoints,
  theses,
  trades,
  upsertMarket,
  users,
  type Db,
  type MarketUpsert,
} from '../src/index';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BTC15M2611170745-UP',
  eventTicker: 'BTC15M2611170745',
  contractTicker: 'UP',
  title: 'BTC price today at 2:45am EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: new Date('2026-11-17T07:45:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '64548.75',
  yesBid: '0.22',
  yesAsk: '0.29',
  lastPrice: null,
  keywords: [['bitcoin'], ['btc']],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: { agency: 'lukka', index: 'LS-LRRR-XBTUSD' },
  ...overrides,
});

describe('schema', () => {
  it('creates the eleven tables of the data model', async () => {
    // postgres.js returns the rows as an array, PGlite returns { rows }.
    const result: unknown = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
      table_name: string;
    }>;
    expect(rows.map((r) => r.table_name)).toEqual([
      'agent_runs',
      'agent_state',
      'audits',
      'authors',
      'gemini_connections',
      'markets',
      'price_points',
      'theses',
      'tips',
      'trades',
      'users',
    ]);
  });

  it('gives a new user the default paper balance and limits', async () => {
    const [user] = await db.insert(users).values({ displayName: 'Guest 1' }).returning();
    expect(user).toMatchObject({
      isGuest: true,
      tradingMode: 'paper',
      paperBalanceUsd: '1000.00',
      maxPerTradeUsd: '10.00',
      dailyCopyCapUsd: '25.00',
    });
  });

  it('enforces thesis format and one live thesis per author per market', async () => {
    const [author] = await db
      .insert(authors)
      .values({ kind: 'agent', agentKey: 'momentum', displayName: 'Momentum' })
      .returning();
    const { id: marketId } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-T-1' }));
    const base = {
      authorId: author!.id,
      marketId,
      side: 'yes' as const,
      probabilityYes: '0.7',
      headline: 'h',
      body: 'b',
    };

    await expect(
      db.insert(theses).values({ ...base, onchainId: '0x01', body: 'x'.repeat(1201) }),
    ).rejects.toThrow();
    await expect(
      db.insert(theses).values({ ...base, onchainId: '0x02', probabilityYes: '1.2' }),
    ).rejects.toThrow();

    await db.insert(theses).values({ ...base, onchainId: '0x03', status: 'blocked' });
    await db.insert(theses).values({ ...base, onchainId: '0x04', status: 'published' });
    await expect(
      db.insert(theses).values({ ...base, onchainId: '0x05', status: 'published' }),
    ).rejects.toThrow();
  });

  it('rejects an agent author without an agent key', async () => {
    await expect(
      db.insert(authors).values({ kind: 'agent', displayName: 'No key' }),
    ).rejects.toThrow();
  });

  it('rejects a repeated idempotency key and a trade with no owner', async () => {
    const [user] = await db.insert(users).values({ displayName: 'Guest 2' }).returning();
    const { id: marketId } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-T-2' }));
    const trade = {
      userId: user!.id,
      marketId,
      side: 'yes' as const,
      quantity: '8',
      price: '0.62',
      costUsd: '4.96',
      mode: 'paper' as const,
      idempotencyKey: 'k1',
    };
    await db.insert(trades).values(trade);
    await expect(db.insert(trades).values(trade)).rejects.toThrow();
    await expect(
      db.insert(trades).values({ ...trade, userId: null, idempotencyKey: 'k2' }),
    ).rejects.toThrow();
  });
});

describe('market queries used by the recorder', () => {
  it('inserts a market once and updates it on the next upsert', async () => {
    const first = await upsertMarket(db, market());
    const second = await upsertMarket(db, market({ yesBid: '0.31', yesAsk: null, marketState: 'closed' }));
    expect(second.id).toBe(first.id);

    const rows = await db
      .select()
      .from(markets)
      .where(sql`${markets.instrumentSymbol} = 'GEMI-BTC15M2611170745-UP'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tracked: true,
      yesBid: '0.3100',
      yesAsk: null,
      marketState: 'closed',
      strike: '64548.75',
      keywords: [['bitcoin'], ['btc']],
      resolutionSide: null,
    });
    expect(rows[0]!.expiryAt?.toISOString()).toBe('2026-11-17T07:45:00.000Z');
  });

  it('lists the tracked symbols of an event', async () => {
    await upsertMarket(
      db,
      market({ instrumentSymbol: 'GEMI-BTC2611172200-HI64750', eventTicker: 'BTC2611172200' }),
    );
    expect(await listTrackedSymbolsForEvent(db, 'BTC2611172200')).toEqual([
      'GEMI-BTC2611172200-HI64750',
    ]);
    expect(await listTrackedSymbolsForEvent(db, 'NOPE')).toEqual([]);
  });

  it('records price points and reports recorder status per symbol', async () => {
    const { id: a } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-S-A', eventTicker: 'S' }));
    const { id: b } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-S-B', eventTicker: 'S' }));
    const t0 = new Date('2026-11-17T07:30:00Z');
    const t1 = new Date('2026-11-17T07:30:30Z');
    await insertPricePoint(db, { marketId: a, ts: t0, yesBid: '0.2', yesAsk: '0.3', lastPrice: null, source: 'rest' });
    await insertPricePoint(db, { marketId: a, ts: t1, yesBid: '0.25', yesAsk: '0.3', lastPrice: '0.27', source: 'rest' });
    await insertPricePoint(db, { marketId: b, ts: t0, yesBid: null, yesAsk: '0.9', lastPrice: null, source: 'rest' });

    const all = await db.select().from(pricePoints).where(sql`${pricePoints.marketId} = ${a}`);
    expect(all).toHaveLength(2);

    const status = await getRecorderStatus(db, new Date('2026-11-17T07:30:10Z'));
    const bySymbol = Object.fromEntries(status.map((row) => [row.instrumentSymbol, row]));
    // Only the point after the cutoff counts for A; B has none after it.
    expect(bySymbol['GEMI-S-A']).toMatchObject({ points: 1 });
    expect(bySymbol['GEMI-S-A']!.latestTs?.toISOString()).toBe(t1.toISOString());
    expect(bySymbol['GEMI-S-B']).toMatchObject({ points: 0, latestTs: null });
  });
});
