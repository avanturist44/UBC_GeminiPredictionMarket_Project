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
  tips,
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
  it('creates the application and publication workflow tables', async () => {
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
      'audit_control',
      'audits',
      'authors',
      'chain_actions',
      'chain_control',
      'copy_requests',
      'gemini_connections',
      'markets',
      'price_points',
      'session_windows',
      'theses',
      'thesis_jobs',
      'thesis_registrations',
      'tips',
      'trades',
      'users',
      'wallet_accounts',
    ]);
  });

  it('turns row-level security on for every table', async () => {
    // Supabase grants its public API roles access to new tables. With row-level security
    // on and no policies, those roles see nothing. The app connects as the table owner,
    // which is exempt, so the other tests in this file prove it still reads and writes.
    const result: unknown = await db.execute(
      sql`select c.relname as table_name from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
          order by 1`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
      table_name: string;
    }>;
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('gives a new user the default paper balance and limits', async () => {
    const [user] = await db.insert(users).values({ displayName: 'Guest 1' }).returning();
    expect(user).toMatchObject({
      isGuest: true,
      tradingMode: 'paper',
      paperBalanceUsd: '1000.0000',
      maxPerTradeUsd: '10.0000',
      dailyCopyCapUsd: '25.0000',
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
    await expect(
      db.insert(theses).values({ ...base, onchainId: '0x06', headline: 'x'.repeat(91) }),
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

describe('trades and tips', () => {
  async function thesisWithAuthor(tag: string) {
    const [user] = await db.insert(users).values({ displayName: `Author ${tag}` }).returning();
    const [author] = await db
      .insert(authors)
      .values({ kind: 'human', userId: user!.id, displayName: `Author ${tag}` })
      .returning();
    const { id: marketId } = await upsertMarket(db, market({ instrumentSymbol: `GEMI-TT-${tag}` }));
    const [thesis] = await db
      .insert(theses)
      .values({
        onchainId: `0xtt${tag}`,
        authorId: author!.id,
        marketId,
        side: 'yes',
        probabilityYes: '0.6',
        headline: 'h',
        body: 'b',
      })
      .returning();
    const authorTrade = (key: string, status: 'pending' | 'filled' | 'rejected') => ({
      userId: user!.id,
      authorId: author!.id,
      marketId,
      thesisId: thesis!.id,
      isAuthorPosition: true,
      side: 'yes' as const,
      quantity: '16.39',
      price: '0.61',
      costUsd: '9.9979',
      mode: 'paper' as const,
      status,
      idempotencyKey: key,
    });
    return { user: user!, thesis: thesis!, authorTrade };
  }

  it('stores a cost to the hundredth of a cent, so caps and profit do not drift', async () => {
    const { authorTrade } = await thesisWithAuthor('a');
    const [trade] = await db.insert(trades).values(authorTrade('a1', 'filled')).returning();
    // 16.39 contracts at 61 cents.
    expect(trade!.costUsd).toBe('9.9979');
  });

  it('allows one live author position per thesis, and a retry after a rejected fill', async () => {
    const { authorTrade } = await thesisWithAuthor('b');
    await db.insert(trades).values(authorTrade('b1', 'rejected'));
    await db.insert(trades).values(authorTrade('b2', 'filled'));
    await expect(db.insert(trades).values(authorTrade('b3', 'filled'))).rejects.toThrow();
    await expect(db.insert(trades).values(authorTrade('b4', 'pending'))).rejects.toThrow();
  });

  it('rejects a tip of zero', async () => {
    const { user, thesis } = await thesisWithAuthor('c');
    const tip = { thesisId: thesis.id, userId: user.id };
    await expect(db.insert(tips).values({ ...tip, amountUsdc: '0' })).rejects.toThrow();
    const [stored] = await db.insert(tips).values({ ...tip, amountUsdc: '0.25' }).returning();
    expect(stored).toMatchObject({ amountUsdc: '0.250000', status: 'pending' });
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
