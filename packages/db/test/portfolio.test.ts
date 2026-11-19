import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  getAccountStats,
  getPortfolioData,
  pricePoints,
  theses,
  tips,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '../src';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const NOW = new Date('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

const market = (symbol: string): MarketUpsert => ({
  instrumentSymbol: symbol,
  eventTicker: 'BRENT2611192200',
  contractTicker: 'HI90',
  title: `Market ${symbol}`,
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-19T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '90',
  yesBid: '0.51',
  yesAsk: '0.55',
  lastPrice: '0.57',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
});

let seq = 0;
async function thesisBy(authorId: string, marketId: string) {
  seq += 1;
  const [row] = await db
    .insert(theses)
    .values({
      onchainId: `0x${String(seq).padStart(64, '0')}`,
      authorId,
      marketId,
      side: 'yes',
      probabilityYes: '0.7',
      headline: `Headline ${seq}`,
      body: `Body ${seq}`,
      status: 'published',
      publishedAt: at(300),
    })
    .returning();
  return row!;
}

async function trade(options: {
  userId: string;
  marketId: string;
  thesisId?: string;
  authorId?: string;
  own?: boolean;
  minutesAgo: number;
  status?: 'filled' | 'settled' | 'rejected';
}) {
  seq += 1;
  await db.insert(trades).values({
    userId: options.userId,
    authorId: options.authorId ?? null,
    marketId: options.marketId,
    thesisId: options.thesisId ?? null,
    isAuthorPosition: options.own ?? false,
    side: 'yes',
    quantity: '10',
    price: '0.50',
    costUsd: '5.0000',
    mode: 'paper',
    status: options.status ?? 'filled',
    idempotencyKey: `p${seq}`,
    createdAt: at(options.minutesAgo),
  });
}

describe('getPortfolioData', () => {
  it('returns the user’s counted positions, oldest first, and starts at the first one', async () => {
    const me = await createGuestUser(db, 'Me');
    const other = await createGuestUser(db, 'Other');
    const a = await upsertMarket(db, market('GEMI-A'));
    const b = await upsertMarket(db, market('GEMI-B'));
    await trade({ userId: me.id, marketId: a.id, minutesAgo: 60 });
    await trade({ userId: me.id, marketId: b.id, minutesAgo: 120 });
    await trade({ userId: me.id, marketId: b.id, minutesAgo: 30, status: 'rejected' });
    await trade({ userId: other.id, marketId: a.id, minutesAgo: 200 });

    const data = await getPortfolioData(db, me.id, { now: NOW, slots: 10 });
    expect(data.trades.map((t) => t.marketId)).toEqual([b.id, a.id]);
    expect(data.since).toEqual(at(120));
    expect(data.markets.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('reads prices only from the first position on, one per slot', async () => {
    const me = await createGuestUser(db, 'Me');
    const a = await upsertMarket(db, market('GEMI-A'));
    await trade({ userId: me.id, marketId: a.id, minutesAgo: 100 });
    const point = (minutesAgo: number, bid: string) => ({
      marketId: a.id,
      ts: at(minutesAgo),
      yesBid: bid,
      yesAsk: '0.60',
      lastPrice: null,
      source: 'ws' as const,
    });
    // Ten slots over 100 minutes: 10 minutes each. 95 and 91 share a slot; 150 is before the start.
    await db.insert(pricePoints).values([point(150, '0.10'), point(95, '0.20'), point(91, '0.30'), point(40, '0.40')]);

    const data = await getPortfolioData(db, me.id, { now: NOW, slots: 10 });
    expect(data.prices.map((p) => p.yesBid)).toEqual(['0.3000', '0.4000']);
  });

  it('is empty for a user with no positions', async () => {
    const me = await createGuestUser(db, 'Me');
    expect(await getPortfolioData(db, me.id, { now: NOW, slots: 10 })).toEqual({
      trades: [],
      markets: [],
      prices: [],
      since: null,
    });
  });
});

describe('getAccountStats', () => {
  it('counts authors copied, other people who copied the user, and tips paid to the user', async () => {
    const me = await createGuestUser(db, 'Me');
    const fan = await createGuestUser(db, 'Fan');
    const fan2 = await createGuestUser(db, 'Fan two');
    const mine = await ensureHumanAuthor(db, me);
    const agent = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News Desk', strategySummary: 's' });
    const other = await ensureHumanAuthor(db, fan);
    const m = await upsertMarket(db, market('GEMI-A'));
    const myThesis = await thesisBy(mine.id, m.id);
    const agentThesis = await thesisBy(agent.id, m.id);
    const otherThesis = await thesisBy(other.id, m.id);

    // The user copies two authors (one of them twice) and holds their own thesis's position.
    await trade({ userId: me.id, marketId: m.id, thesisId: agentThesis.id, minutesAgo: 50 });
    await trade({ userId: me.id, marketId: m.id, thesisId: agentThesis.id, minutesAgo: 40 });
    await trade({ userId: me.id, marketId: m.id, thesisId: otherThesis.id, minutesAgo: 30 });
    await trade({ userId: me.id, marketId: m.id, thesisId: myThesis.id, authorId: mine.id, own: true, minutesAgo: 60 });
    // Two people copy the user; a rejected copy does not count.
    await trade({ userId: fan.id, marketId: m.id, thesisId: myThesis.id, minutesAgo: 20 });
    await trade({ userId: fan2.id, marketId: m.id, thesisId: myThesis.id, minutesAgo: 10 });
    await trade({ userId: fan2.id, marketId: m.id, thesisId: myThesis.id, minutesAgo: 5, status: 'rejected' });
    // Paid tips on the user's thesis count; a refunded one and tips to others do not.
    await db.insert(tips).values([
      { thesisId: myThesis.id, userId: fan.id, amountUsdc: '0.25', status: 'paid' },
      { thesisId: myThesis.id, userId: fan2.id, amountUsdc: '0.50', status: 'paid' },
      { thesisId: myThesis.id, userId: fan2.id, amountUsdc: '1.00', status: 'refunded' },
      { thesisId: agentThesis.id, userId: me.id, amountUsdc: '0.25', status: 'paid' },
    ]);

    const stats = await getAccountStats(db, me.id);
    expect(stats).toEqual({ copying: 2, copiers: 2, tipsEarnedUsdc: expect.any(String) });
    expect(Number(stats.tipsEarnedUsdc)).toBe(0.75);
  });

  it('is all zero for a new user', async () => {
    const me = await createGuestUser(db, 'Me');
    expect(await getAccountStats(db, me.id)).toEqual({ copying: 0, copiers: 0, tipsEarnedUsdc: '0' });
  });
});
