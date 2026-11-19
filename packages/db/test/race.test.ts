import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentRuns,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  getRaceData,
  pricePoints,
  theses,
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

const NOW = new Date('2026-11-18T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

const market = (symbol: string): MarketUpsert => ({
  instrumentSymbol: symbol,
  eventTicker: 'BRENT2611182200',
  contractTicker: 'HI90',
  title: `Market ${symbol}`,
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-18T22:00:00Z'),
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
/** A trade, and with `thesis: true` the published thesis it backs (one live thesis per author and market). */
async function position(
  authorId: string,
  marketId: string,
  options: {
    minutesAgo: number;
    status?: 'filled' | 'settled' | 'rejected' | 'pending';
    userId?: string;
    author?: boolean;
    thesis?: boolean;
  },
) {
  seq += 1;
  const [thesis] = options.thesis
    ? await db
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
          publishedAt: at(options.minutesAgo),
        })
        .returning()
    : [null];
  await db.insert(trades).values({
    authorId,
    userId: options.userId ?? null,
    marketId,
    thesisId: thesis?.id ?? null,
    isAuthorPosition: options.author ?? true,
    side: 'yes',
    quantity: '10',
    price: '0.50',
    costUsd: '5.0000',
    mode: 'paper',
    status: options.status ?? 'filled',
    idempotencyKey: `k${seq}`,
    createdAt: at(options.minutesAgo),
  });
  return thesis;
}

describe('getRaceData', () => {
  it('returns each agent’s own counted positions, with the thesis behind each, in the order asked', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News Desk', strategySummary: 'Reads the news.' });
    const fade = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 'Fades moves.' });
    const { id: marketId } = await upsertMarket(db, market('GEMI-A'));
    const thesis = (await position(news.id, marketId, { minutesAgo: 60, thesis: true }))!;
    await position(news.id, marketId, { minutesAgo: 50, status: 'rejected' });
    await position(news.id, marketId, { minutesAgo: 40, status: 'pending' });
    // A person copying the agent is not the agent's position.
    const copier = await createGuestUser(db, 'Copier');
    await position(news.id, marketId, { minutesAgo: 30, userId: copier.id, author: false });

    const race = await getRaceData(db, ['news', 'fade'], { now: NOW, slots: 10 });
    expect(race.agents.map((a) => a.author?.displayName)).toEqual(['News Desk', 'Fade']);
    expect(race.agents[0]!.trades).toHaveLength(1);
    expect(race.agents[0]!.trades[0]).toMatchObject({ status: 'filled', costUsd: '5.0000', thesis: { id: thesis.id, headline: thesis.headline } });
    expect(race.agents[1]!.trades).toEqual([]);
    expect(race.agents[1]!.author?.id).toBe(fade.id);
    expect(race.since?.toISOString()).toBe(at(60).toISOString());
    expect(race.markets.map((m) => m.instrumentSymbol)).toEqual(['GEMI-A']);
  });

  it('ignores a person’s own theses, even under an agent key that does not exist', async () => {
    const user = await createGuestUser(db, 'Sam');
    const human = await ensureHumanAuthor(db, user);
    const { id: marketId } = await upsertMarket(db, market('GEMI-A'));
    await position(human.id, marketId, { minutesAgo: 10 });
    const race = await getRaceData(db, ['news', 'fade'], { now: NOW, slots: 10 });
    expect(race.agents.every((a) => a.author === null && a.trades.length === 0)).toBe(true);
    expect(race.since).toBeNull();
    expect(race.prices).toEqual([]);
  });

  it('keeps one price per market per slot, the last one in it, and only from the race’s start', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News Desk', strategySummary: 's' });
    const { id: marketId } = await upsertMarket(db, market('GEMI-A'));
    await position(news.id, marketId, { minutesAgo: 60 });
    const point = (minutesAgo: number, bid: string) => ({
      marketId,
      ts: at(minutesAgo),
      yesBid: bid,
      yesAsk: '0.60',
      lastPrice: null,
      source: 'ws' as const,
    });
    // Ten slots of six minutes. Two points share the first slot; the later one wins.
    await db.insert(pricePoints).values([point(90, '0.10'), point(59, '0.40'), point(57, '0.45'), point(20, '0.50')]);

    const race = await getRaceData(db, ['news'], { now: NOW, slots: 10 });
    expect(race.prices.map((p) => [p.ts.toISOString(), p.yesBid])).toEqual([
      [at(57).toISOString(), '0.4500'],
      [at(20).toISOString(), '0.5000'],
    ]);
  });

  it('gives each agent its latest decision, with the market it looked at', async () => {
    await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News Desk', strategySummary: 's' });
    const { id: marketId } = await upsertMarket(db, market('GEMI-A'));
    await db.insert(agentRuns).values([
      { agentKey: 'news', decision: 'skip', reason: 'Older look.', createdAt: at(30) },
      { agentKey: 'news', marketId, decision: 'trade', reason: 'Puts YES at 72%, 14 points from the price.', createdAt: at(5) },
      { agentKey: 'fade', decision: 'skip', reason: 'No market moved 10 points in the last 30 minutes.', createdAt: at(1) },
    ]);
    const race = await getRaceData(db, ['news', 'fade'], { now: NOW, slots: 10 });
    expect(race.agents[0]!.latestRun).toMatchObject({ decision: 'trade', reason: 'Puts YES at 72%, 14 points from the price.', marketTitle: 'Market GEMI-A' });
    expect(race.agents[1]!.latestRun).toMatchObject({ decision: 'skip', marketTitle: null });
  });
});
