import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  getAuthorPortfolioData,
  getAuthorStats,
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
async function thesisBy(authorId: string, marketId: string, status: 'published' | 'resolved' | 'blocked' = 'published') {
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
      status,
      publishedAt: status === 'blocked' ? null : at(300),
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
    payoutUsd: options.status === 'settled' ? '10.0000' : null,
    mode: 'paper',
    status: options.status ?? 'filled',
    idempotencyKey: `a${seq}`,
    createdAt: at(options.minutesAgo),
  });
}

describe('getAuthorPortfolioData', () => {
  it('holds only the positions behind the author’s public theses, oldest first', async () => {
    const writer = await createGuestUser(db, 'Writer');
    const fan = await createGuestUser(db, 'Fan');
    const author = await ensureHumanAuthor(db, writer);
    const a = await upsertMarket(db, market('GEMI-A'));
    const b = await upsertMarket(db, market('GEMI-B'));
    const open = await thesisBy(author.id, a.id);
    const resolved = await thesisBy(author.id, b.id, 'resolved');
    const blocked = await thesisBy(author.id, a.id, 'blocked');
    const elsewhere = await thesisBy((await ensureHumanAuthor(db, fan)).id, a.id);

    await trade({ userId: writer.id, marketId: a.id, thesisId: open.id, authorId: author.id, own: true, minutesAgo: 60 });
    await trade({
      userId: writer.id,
      marketId: b.id,
      thesisId: resolved.id,
      authorId: author.id,
      own: true,
      minutesAgo: 120,
      status: 'settled',
    });
    // Not public: a blocked thesis's position stays private, even if one were recorded.
    await trade({ userId: writer.id, marketId: a.id, thesisId: blocked.id, authorId: author.id, own: true, minutesAgo: 30 });
    // Not the author's positions: a copy of their thesis, and their own copy of someone else's.
    await trade({ userId: fan.id, marketId: a.id, thesisId: open.id, minutesAgo: 20 });
    await trade({ userId: writer.id, marketId: a.id, thesisId: elsewhere.id, minutesAgo: 10 });

    const data = await getAuthorPortfolioData(db, author.id, { now: NOW, slots: 10 });
    expect(data.trades.map((t) => [t.marketId, t.status])).toEqual([
      [b.id, 'settled'],
      [a.id, 'filled'],
    ]);
    expect(data.since).toEqual(at(120));
    expect(data.markets.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('works for an agent, which has no user', async () => {
    const agent = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News Desk', strategySummary: 's' });
    const runner = await createGuestUser(db, 'Agent runner');
    const m = await upsertMarket(db, market('GEMI-A'));
    const thesis = await thesisBy(agent.id, m.id);
    await trade({ userId: runner.id, marketId: m.id, thesisId: thesis.id, authorId: agent.id, own: true, minutesAgo: 45 });

    const data = await getAuthorPortfolioData(db, agent.id, { now: NOW, slots: 10 });
    expect(data.trades).toHaveLength(1);
    expect(data.since).toEqual(at(45));
  });

  it('is empty for an author with no positions', async () => {
    const author = await ensureHumanAuthor(db, await createGuestUser(db, 'New'));
    expect(await getAuthorPortfolioData(db, author.id, { now: NOW, slots: 10 })).toEqual({
      trades: [],
      markets: [],
      prices: [],
      since: null,
    });
  });
});

describe('getAuthorStats', () => {
  it('counts people who copied the author, and tips paid and held on their public theses', async () => {
    const agent = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 's' });
    const fan = await createGuestUser(db, 'Fan');
    const fan2 = await createGuestUser(db, 'Fan two');
    // An author holds one live thesis per market, so each thesis gets its own.
    const m = await upsertMarket(db, market('GEMI-A'));
    const m2 = await upsertMarket(db, market('GEMI-B'));
    const one = await thesisBy(agent.id, m.id);
    const two = await thesisBy(agent.id, m2.id, 'resolved');
    const blocked = await thesisBy(agent.id, m.id, 'blocked');

    await trade({ userId: fan.id, marketId: m.id, thesisId: one.id, minutesAgo: 30 });
    await trade({ userId: fan.id, marketId: m.id, thesisId: two.id, minutesAgo: 20 });
    await trade({ userId: fan2.id, marketId: m.id, thesisId: two.id, minutesAgo: 10 });
    await trade({ userId: fan2.id, marketId: m.id, thesisId: one.id, minutesAgo: 5, status: 'rejected' });
    await db.insert(tips).values([
      { thesisId: two.id, userId: fan.id, amountUsdc: '0.25', status: 'paid' },
      { thesisId: two.id, userId: fan2.id, amountUsdc: '0.50', status: 'paid' },
      { thesisId: one.id, userId: fan.id, amountUsdc: '1.00', status: 'escrowed' },
      { thesisId: one.id, userId: fan2.id, amountUsdc: '2.00', status: 'refunded' },
      { thesisId: blocked.id, userId: fan2.id, amountUsdc: '5.00', status: 'escrowed' },
    ]);

    const stats = await getAuthorStats(db, agent.id);
    expect(stats.copiers).toBe(2);
    expect(Number(stats.tipsEarnedUsdc)).toBe(0.75);
    expect(Number(stats.tipsHeldUsdc)).toBe(1);
  });

  it('is all zero for a new author', async () => {
    const author = await ensureHumanAuthor(db, await createGuestUser(db, 'New'));
    expect(await getAuthorStats(db, author.id)).toEqual({ copiers: 0, tipsEarnedUsdc: '0', tipsHeldUsdc: '0' });
  });
});
