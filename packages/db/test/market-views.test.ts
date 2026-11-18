import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authors,
  eq,
  getMarketDetail,
  insertPricePoint,
  listLiveTrackedMarkets,
  listOpenMarkets,
  markets,
  pricePoints,
  recordStreamQuote,
  sql,
  theses,
  upsertMarket,
  users,
  type Db,
  type MarketUpsert,
} from '../src/index';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const NOW = new Date('2026-11-18T03:05:00Z');

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BTC15M2611180315-UP',
  eventTicker: 'BTC15M2611180315',
  contractTicker: 'UP',
  title: 'BTC price today at 10:15pm EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: new Date('2026-11-18T03:15:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '64931.38',
  yesBid: '0.89',
  yesAsk: '0.95',
  lastPrice: '0.83',
  keywords: [['bitcoin']],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: { agency: 'lukka', index: 'LS-LRRR-XBTUSD' },
  ...overrides,
});

let authorSeq = 0;
async function author(kind: 'agent' | 'human'): Promise<string> {
  authorSeq += 1;
  if (kind === 'agent') {
    const [row] = await db
      .insert(authors)
      .values({ kind, agentKey: `agent-${authorSeq}`, displayName: `Agent ${authorSeq}` })
      .returning();
    return row!.id;
  }
  const [user] = await db.insert(users).values({ displayName: `Person ${authorSeq}` }).returning();
  const [row] = await db
    .insert(authors)
    .values({ kind, userId: user!.id, displayName: `Person ${authorSeq}` })
    .returning();
  return row!.id;
}

let thesisSeq = 0;
async function thesis(
  marketId: string,
  kind: 'agent' | 'human',
  side: 'yes' | 'no',
  probabilityYes: string,
  status: 'draft' | 'blocked' | 'published' | 'resolved' = 'published',
  publishedAt = new Date('2026-11-18T03:02:00Z'),
) {
  thesisSeq += 1;
  const [row] = await db
    .insert(theses)
    .values({
      onchainId: `0xmv${thesisSeq}`,
      authorId: await author(kind),
      marketId,
      side,
      probabilityYes,
      headline: `Headline ${thesisSeq}`,
      body: 'b',
      status,
      publishedAt: status === 'published' || status === 'resolved' ? publishedAt : null,
    })
    .returning();
  return row!;
}

describe('listLiveTrackedMarkets', () => {
  it('returns tracked contracts that have not expired, for the stream to subscribe to', async () => {
    const live = await upsertMarket(db, market());
    await upsertMarket(
      db,
      market({ instrumentSymbol: 'GEMI-BTC15M2611180300-UP', expiryAt: new Date('2026-11-18T03:00:00Z') }),
    );
    const open = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-NOEXPIRY-X', expiryAt: null }));
    const untracked = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-UNTRACKED-X' }));
    await db.update(markets).set({ tracked: false }).where(eq(markets.id, untracked.id));

    expect(await listLiveTrackedMarkets(db, NOW)).toEqual([
      { id: live.id, instrumentSymbol: 'GEMI-BTC15M2611180315-UP' },
      { id: open.id, instrumentSymbol: 'GEMI-NOEXPIRY-X' },
    ]);
  });
});

describe('recordStreamQuote', () => {
  it('writes a ws price point and moves the market’s quote', async () => {
    const { id } = await upsertMarket(db, market());
    const ts = new Date('2026-11-18T03:05:10Z');
    await recordStreamQuote(db, { marketId: id, ts, yesBid: '0.9', yesAsk: null, lastPrice: '0.91' });

    const points = await db.select().from(pricePoints);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      marketId: id,
      yesBid: '0.9000',
      yesAsk: null,
      lastPrice: '0.9100',
      source: 'ws',
    });
    expect(points[0]!.ts.toISOString()).toBe(ts.toISOString());

    const [row] = await db.select().from(markets).where(eq(markets.id, id));
    expect(row).toMatchObject({ yesBid: '0.9000', yesAsk: null, lastPrice: '0.9100' });
  });

  it('keeps the stored last trade when the stream carries none', async () => {
    const { id } = await upsertMarket(db, market());
    await recordStreamQuote(db, {
      marketId: id,
      ts: NOW,
      yesBid: '0.5',
      yesAsk: '0.6',
      lastPrice: null,
    });
    const [row] = await db.select().from(markets).where(eq(markets.id, id));
    expect(row).toMatchObject({ yesBid: '0.5000', yesAsk: '0.6000', lastPrice: '0.8300' });
  });

  it('stores nothing when the market row cannot be updated, so a retry cannot duplicate the point', async () => {
    const { id } = await upsertMarket(db, market());
    await db.execute(sql`
      create function fail_market_update() returns trigger language plpgsql as $$
      begin raise exception 'market update refused'; end $$`);
    await db.execute(
      sql`create trigger refuse_update before update on markets for each row execute function fail_market_update()`,
    );
    const quote = { marketId: id, ts: NOW, yesBid: '0.5', yesAsk: '0.6', lastPrice: null };
    await expect(recordStreamQuote(db, quote)).rejects.toThrow();
    await expect(recordStreamQuote(db, quote)).rejects.toThrow();
    expect(await db.select().from(pricePoints)).toHaveLength(0);
  });

  it('says whether it stored a price point', async () => {
    const { id } = await upsertMarket(db, market());
    const base = { marketId: id, ts: NOW };
    expect(
      await recordStreamQuote(db, { ...base, yesBid: '0.5', yesAsk: null, lastPrice: null }),
    ).toEqual({ point: true });
    expect(
      await recordStreamQuote(db, { ...base, yesBid: null, yesAsk: null, lastPrice: null }),
    ).toEqual({ point: false });
  });

  it('stores no price point for an empty book, and clears the market’s quote', async () => {
    const { id } = await upsertMarket(db, market());
    await recordStreamQuote(db, { marketId: id, ts: NOW, yesBid: null, yesAsk: null, lastPrice: null });
    expect(await db.select().from(pricePoints)).toHaveLength(0);
    const [row] = await db.select().from(markets).where(eq(markets.id, id));
    expect(row).toMatchObject({ yesBid: null, yesAsk: null, lastPrice: '0.8300' });
  });
});

describe('listOpenMarkets', () => {
  it('lists tracked contracts that have not expired, soonest first, with no expiry last', async () => {
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-LONG-X', expiryAt: new Date('2027-02-01T00:00:00Z') }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-NOEXPIRY-X', expiryAt: null }));
    await upsertMarket(db, market());
    await upsertMarket(
      db,
      market({ instrumentSymbol: 'GEMI-BTC15M2611180300-UP', expiryAt: new Date('2026-11-18T03:00:00Z') }),
    );

    const rows = await listOpenMarkets(db, NOW);
    expect(rows.map((r) => r.instrumentSymbol)).toEqual([
      'GEMI-BTC15M2611180315-UP',
      'GEMI-LONG-X',
      'GEMI-NOEXPIRY-X',
    ]);
    expect(rows[0]).toMatchObject({
      eventTicker: 'BTC15M2611180315',
      title: 'BTC price today at 10:15pm EST',
      contractLabel: 'Up',
      category: 'Crypto',
      marketState: 'open',
      strike: '64931.38',
      yesBid: '0.8900',
      yesAsk: '0.9500',
      lastPrice: '0.8300',
      thesesYes: 0,
      thesesNo: 0,
    });
    expect(rows[0]!.expiryAt?.toISOString()).toBe('2026-11-18T03:15:00.000Z');
  });

  it('counts published theses per side and leaves out drafts and blocked ones', async () => {
    const { id } = await upsertMarket(db, market());
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    await thesis(id, 'agent', 'yes', '0.9');
    await thesis(id, 'human', 'yes', '0.8');
    await thesis(id, 'human', 'no', '0.3');
    await thesis(id, 'human', 'no', '0.2', 'draft');
    await thesis(id, 'agent', 'no', '0.2', 'blocked');
    await thesis(other.id, 'agent', 'no', '0.1');

    const rows = await listOpenMarkets(db, NOW);
    const bySymbol = Object.fromEntries(rows.map((r) => [r.instrumentSymbol, r]));
    expect(bySymbol['GEMI-BTC15M2611180315-UP']).toMatchObject({ thesesYes: 2, thesesNo: 1 });
    expect(bySymbol['GEMI-OTHER-X']).toMatchObject({ thesesYes: 0, thesesNo: 1 });
  });
});

describe('getMarketDetail', () => {
  it('returns null for a symbol that is not tracked', async () => {
    expect(await getMarketDetail(db, 'GEMI-NOPE-X')).toBeNull();
  });

  it('returns the market, its price points oldest first, and no theses on a new market', async () => {
    const { id } = await upsertMarket(db, market());
    const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 3, 0, s));
    await insertPricePoint(db, { marketId: id, ts: t(30), yesBid: '0.5', yesAsk: '0.6', lastPrice: null, source: 'rest' });
    await insertPricePoint(db, { marketId: id, ts: t(0), yesBid: '0.4', yesAsk: '0.5', lastPrice: null, source: 'rest' });
    await insertPricePoint(db, { marketId: id, ts: t(10), yesBid: null, yesAsk: '0.5', lastPrice: '0.45', source: 'ws' });

    const detail = await getMarketDetail(db, 'GEMI-BTC15M2611180315-UP');
    expect(detail!.market).toMatchObject({
      instrumentSymbol: 'GEMI-BTC15M2611180315-UP',
      eventTicker: 'BTC15M2611180315',
      strike: '64931.38',
      resolutionSide: null,
      resolvedAt: null,
      thesesYes: 0,
      thesesNo: 0,
    });
    expect(detail!.points).toEqual([
      { ts: t(0), yesBid: '0.4000', yesAsk: '0.5000', lastPrice: null },
      { ts: t(10), yesBid: null, yesAsk: '0.5000', lastPrice: '0.4500' },
      { ts: t(30), yesBid: '0.5000', yesAsk: '0.6000', lastPrice: null },
    ]);
    expect(detail!.theses).toEqual([]);
  });

  it('still returns a contract after it has expired', async () => {
    await upsertMarket(db, market({ expiryAt: new Date('2020-01-01T00:00:00Z'), marketState: 'closed' }));
    const detail = await getMarketDetail(db, 'GEMI-BTC15M2611180315-UP');
    expect(detail!.market).toMatchObject({ marketState: 'closed' });
  });

  it('thins a long history to the point limit and keeps the newest point', async () => {
    const { id } = await upsertMarket(db, market());
    const start = Date.UTC(2026, 10, 18, 0, 0, 0);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      marketId: id,
      ts: new Date(start + i * 10_000),
      yesBid: (0.1 + (i % 50) / 100).toFixed(2),
      yesAsk: null,
      lastPrice: null,
      source: 'ws' as const,
    }));
    await db.insert(pricePoints).values(rows);

    const detail = await getMarketDetail(db, 'GEMI-BTC15M2611180315-UP', { maxPoints: 100 });
    const times = detail!.points.map((p) => p.ts.getTime());
    expect(times.length).toBeLessThanOrEqual(100);
    expect(times.length).toBeGreaterThanOrEqual(90);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBe(start + 999 * 10_000);
    // Spread across the whole history, not the first or last hundred rows.
    expect(times[0]).toBeLessThan(start + 20 * 10_000);
  });

  it('lists published theses as chart markers, oldest first, with the author kind', async () => {
    const { id } = await upsertMarket(db, market());
    const second = await thesis(id, 'human', 'no', '0.3', 'published', new Date('2026-11-18T03:04:00Z'));
    const first = await thesis(id, 'agent', 'yes', '0.9', 'resolved', new Date('2026-11-18T03:01:00Z'));
    await thesis(id, 'human', 'yes', '0.7', 'draft');

    const detail = await getMarketDetail(db, 'GEMI-BTC15M2611180315-UP');
    expect(detail!.theses).toEqual([
      {
        id: first.id,
        headline: first.headline,
        side: 'yes',
        probabilityYes: '0.9000',
        publishedAt: new Date('2026-11-18T03:01:00Z'),
        authorKind: 'agent',
        authorName: expect.stringMatching(/^Agent /),
      },
      {
        id: second.id,
        headline: second.headline,
        side: 'no',
        probabilityYes: '0.3000',
        publishedAt: new Date('2026-11-18T03:04:00Z'),
        authorKind: 'human',
        authorName: expect.stringMatching(/^Person /),
      },
    ]);
    expect(detail!.market).toMatchObject({ thesesYes: 1, thesesNo: 1 });
  });
});
