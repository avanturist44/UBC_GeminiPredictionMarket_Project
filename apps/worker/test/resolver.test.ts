import { EventSchema, type GeminiEvent } from '@thesis/core';
import {
  agentState,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  markets,
  theses,
  trades,
  upsertMarket,
  users,
  type Db,
  type MarketUpsert,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runResolverCycle } from '../src/resolver';

const SYMBOL = 'GEMI-BTC15M2611180500-UP';
const TICKER = 'BTC15M2611180500';
const EXPIRY = new Date('2026-11-18T05:00:00Z');
const NOW = new Date('2026-11-18T05:00:30Z');

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: SYMBOL,
  eventTicker: TICKER,
  contractTicker: 'UP',
  title: 'BTC price today at 12am EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: EXPIRY,
  status: 'active',
  marketState: 'open',
  strike: '64000',
  yesBid: '0.60',
  yesAsk: '0.62',
  lastPrice: null,
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

/** Gemini's reply for the event, with the contract in a given state. */
function event(contract: object, status = 'settled', ticker = TICKER, symbol = SYMBOL): GeminiEvent {
  return EventSchema.parse({
    ticker,
    title: 'BTC price today at 12am EST',
    status,
    contracts: [{ instrumentSymbol: symbol, ticker: 'UP', ...contract }],
  });
}
const YES_WON = event({ status: 'settled', resolutionSide: 'yes', resolvedAt: '2026-11-18T05:00:06.000Z' });
const NO_WON = event({ status: 'settled', resolutionSide: 'no', resolvedAt: '2026-11-18T05:00:06.000Z' });
const PENDING = event({ status: 'closed' }, 'closed');
const VOID = event({ status: 'invalid' }, 'invalid');

let db: Db;
let close: () => Promise<void>;
let marketId: string;
let requests: string[];
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ id: marketId } = await upsertMarket(db, market()));
  requests = [];
});
afterEach(() => close());

function run(replies: Record<string, GeminiEvent | null | Error>, now = NOW) {
  return runResolverCycle({
    db,
    logger,
    now: () => now,
    client: {
      async getEvent(ticker: string) {
        requests.push(ticker);
        const reply = replies[ticker] ?? null;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  });
}

let seq = 0;
async function position(owner: { userId?: string; authorId?: string }, side: 'yes' | 'no', quantity: string, price: string, extra: object = {}) {
  seq += 1;
  const cost = (Number(quantity) * Number(price)).toFixed(4);
  const [row] = await db
    .insert(trades)
    .values({ ...owner, marketId, side, quantity, price, costUsd: cost, mode: 'paper', status: 'filled', idempotencyKey: `p-${seq}`, ...extra })
    .returning();
  return row!;
}
async function thesis(authorId: string, side: 'yes' | 'no', status: 'published' | 'draft' | 'blocked' = 'published') {
  seq += 1;
  const [row] = await db
    .insert(theses)
    .values({ onchainId: `0xr${seq}`, authorId, marketId, side, probabilityYes: '0.6', headline: 'h', body: 'b', status })
    .returning();
  return row!;
}
const tradeOf = async (id: string) => (await db.select().from(trades).where(eq(trades.id, id)))[0]!;
const balanceOf = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!.paperBalanceUsd;

describe('runResolverCycle', () => {
  it('pays $1 a contract to the winning side and nothing to the losing side', async () => {
    const winner = await createGuestUser(db, 'Winner');
    const loser = await createGuestUser(db, 'Loser');
    const won = await position({ userId: winner.id }, 'yes', '8.06', '0.62');
    const lost = await position({ userId: loser.id }, 'no', '10', '0.40');

    expect(await run({ [TICKER]: YES_WON })).toEqual({ checked: 1, resolved: 1, trades: 2, theses: 0 });
    expect(await tradeOf(won.id)).toMatchObject({ status: 'settled', payoutUsd: '8.0600' });
    expect(await tradeOf(lost.id)).toMatchObject({ status: 'settled', payoutUsd: '0.0000' });
    // Balances were not reduced here (the fills did that), so the payout is the whole change.
    expect(await balanceOf(winner.id)).toBe('1008.0600');
    expect(await balanceOf(loser.id)).toBe('1000.0000');

    const [stored] = await db.select().from(markets).where(eq(markets.id, marketId));
    expect(stored).toMatchObject({ resolutionSide: 'yes', status: 'settled', marketState: 'closed' });
    expect(stored!.resolvedAt?.toISOString()).toBe('2026-11-18T05:00:06.000Z');
  });

  it('pays NO holders when NO wins', async () => {
    const user = await createGuestUser(db, 'NoHolder');
    const trade = await position({ userId: user.id }, 'no', '10', '0.40');
    await run({ [TICKER]: NO_WON });
    expect(await tradeOf(trade.id)).toMatchObject({ payoutUsd: '10.0000' });
    expect(await balanceOf(user.id)).toBe('1010.0000');
  });

  it('marks each public thesis right or wrong, and leaves drafts and blocked ones alone', async () => {
    const sam = await ensureHumanAuthor(db, await createGuestUser(db, 'Sam'));
    const ana = await ensureHumanAuthor(db, await createGuestUser(db, 'Ana'));
    const bo = await ensureHumanAuthor(db, await createGuestUser(db, 'Bo'));
    const right = await thesis(sam.id, 'yes');
    const wrong = await thesis(ana.id, 'no');
    const draft = await thesis(bo.id, 'yes', 'draft');
    expect(await run({ [TICKER]: YES_WON })).toMatchObject({ theses: 2 });
    const byId = Object.fromEntries((await db.select().from(theses)).map((t) => [t.id, t]));
    expect(byId[right.id]).toMatchObject({ status: 'resolved', outcome: 'right' });
    expect(byId[wrong.id]).toMatchObject({ status: 'resolved', outcome: 'wrong' });
    expect(byId[draft.id]).toMatchObject({ status: 'draft', outcome: null });
  });

  it('returns every stake when the market is void, and marks theses void', async () => {
    const user = await createGuestUser(db, 'Voided');
    const author = await ensureHumanAuthor(db, user);
    const trade = await position({ userId: user.id }, 'yes', '8.06', '0.62');
    const t = await thesis(author.id, 'yes');
    await run({ [TICKER]: VOID });
    expect(await tradeOf(trade.id)).toMatchObject({ status: 'settled', payoutUsd: '4.9972' });
    expect(await balanceOf(user.id)).toBe('1004.9972');
    expect((await db.select().from(theses).where(eq(theses.id, t.id)))[0]).toMatchObject({ status: 'resolved', outcome: 'void' });
    expect((await db.select().from(markets))[0]).toMatchObject({ resolutionSide: null, status: 'invalid' });
  });

  it('waits when Gemini has no result yet, and never guesses one from the price', async () => {
    const user = await createGuestUser(db, 'Waiting');
    const trade = await position({ userId: user.id }, 'yes', '8.06', '0.62');
    await db.update(markets).set({ yesBid: '0.99', yesAsk: null }).where(eq(markets.id, marketId));
    expect(await run({ [TICKER]: PENDING })).toEqual({ checked: 1, resolved: 0, trades: 0, theses: 0 });
    expect(await tradeOf(trade.id)).toMatchObject({ status: 'filled', payoutUsd: null });
    expect((await db.select().from(markets))[0]).toMatchObject({ resolutionSide: null, resolvedAt: null });
  });

  it('pays nobody twice: a second run, or a re-run after a crash, changes nothing', async () => {
    const user = await createGuestUser(db, 'Once');
    await position({ userId: user.id }, 'yes', '8.06', '0.62');
    await run({ [TICKER]: YES_WON });
    const second = await run({ [TICKER]: YES_WON });
    expect(second).toEqual({ checked: 0, resolved: 0, trades: 0, theses: 0 });
    expect(await balanceOf(user.id)).toBe('1008.0600');
  });

  it('adds an agent’s result to its day, frees its exposure, and halts it at a $50 loss', async () => {
    const agent = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    await db.insert(agentState).values({ agentKey: 'news', day: '2026-11-18', realizedPnlUsd: '-44', openExposureUsd: '16', tradeCount: 3 });
    // A $6 loser here, and a $10 position still open on another market.
    await position({ authorId: agent.id }, 'no', '15', '0.40');
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X', eventTicker: 'OTHER', expiryAt: new Date('2026-11-19T05:00:00Z') }));
    await db.insert(trades).values({ authorId: agent.id, marketId: other.id, side: 'yes', quantity: '20', price: '0.5', costUsd: '10', mode: 'paper', status: 'filled', idempotencyKey: 'still-open' });

    await run({ [TICKER]: YES_WON });
    expect((await db.select().from(agentState))[0]).toMatchObject({
      realizedPnlUsd: '-50.0000',
      openExposureUsd: '10.0000',
      tradeCount: 3,
      halted: true,
      haltReason: 'daily loss stop',
    });
  });

  it('does not halt an agent that is just short of the stop, and counts a win', async () => {
    const agent = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 's' });
    await db.insert(agentState).values({ agentKey: 'fade', day: '2026-11-18', realizedPnlUsd: '-49.99' });
    await position({ authorId: agent.id }, 'yes', '10', '0.60');
    await run({ [TICKER]: YES_WON });
    expect((await db.select().from(agentState))[0]).toMatchObject({ realizedPnlUsd: '-45.9900', halted: false });
  });

  it('settles markets people have a stake in before the rest, and leaves old or live ones alone', async () => {
    const user = await createGuestUser(db, 'Staked');
    await position({ userId: user.id }, 'yes', '1', '0.5');
    for (let i = 0; i < 6; i += 1) {
      await upsertMarket(db, market({ instrumentSymbol: `GEMI-EMPTY-${i}`, eventTicker: `EMPTY${i}`, expiryAt: new Date(NOW.getTime() - (i + 1) * 60_000) }));
    }
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-ANCIENT', eventTicker: 'ANCIENT', expiryAt: new Date(NOW.getTime() - 8 * 86_400_000) }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-LIVE', eventTicker: 'LIVE', expiryAt: new Date(NOW.getTime() + 60_000) }));
    await run({});
    expect(requests).toHaveLength(4);
    expect(requests[0]).toBe(TICKER);
    expect(requests).not.toContain('ANCIENT');
    expect(requests).not.toContain('LIVE');
  });

  it('carries on past a market whose request fails', async () => {
    const user = await createGuestUser(db, 'Carry');
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-ETH15M2611180500-UP', eventTicker: 'ETH15M2611180500' }));
    await db.insert(trades).values({ userId: user.id, marketId: other.id, side: 'yes', quantity: '2', price: '0.5', costUsd: '1', mode: 'paper', status: 'filled', idempotencyKey: 'eth' });
    await position({ userId: user.id }, 'yes', '2', '0.5');
    const summary = await run({
      [TICKER]: new Error('HTTP 500'),
      ETH15M2611180500: event({ status: 'settled', resolutionSide: 'yes' }, 'settled', 'ETH15M2611180500', 'GEMI-ETH15M2611180500-UP'),
    });
    expect(summary).toMatchObject({ checked: 2, resolved: 1, trades: 1 });
  });
});
