import { thesisContentHash, thesisOnchainId } from '@thesis/core';
import {
  createAuditingThesis,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  markets,
  theses,
  tips,
  trades,
  upsertMarket,
  users,
  type Db,
  type MarketUpsert,
  type UserRow,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTrade } from '../lib/copy-trade';

const NOW = new Date('2026-11-18T05:00:00Z');
const SYMBOL = 'GEMI-BRENT2611182200-HI90';

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: SYMBOL,
  eventTicker: 'BRENT2611182200',
  contractTicker: 'HI90',
  title: 'Oil (Brent) price on November 18?',
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-18T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '90',
  yesBid: '0.60',
  yesAsk: '0.62',
  lastPrice: '0.61',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

let db: Db;
let close: () => Promise<void>;
let copier: UserRow;
let marketId: string;
let thesisId: string;
let seq = 0;

/** A published thesis by an agent: YES, bought at 62 cents. */
async function publishedThesis(authorId: string, userId: string | null, onMarket = marketId, side: 'yes' | 'no' = 'yes') {
  const id = randomUUID();
  const content = { headline: 'Supply is tight', body: 'Body', evidence: [{ claim: 'c', url: 'https://example.com' }] };
  await createAuditingThesis(db, {
    id,
    onchainId: thesisOnchainId(id),
    contentHash: thesisContentHash({ market: SYMBOL, side, probabilityYes: 0.7, ...content }),
    authorId,
    userId,
    marketId: onMarket,
    side,
    probabilityYes: '0.7000',
    ...content,
    limitPrice: '0.67',
    quantity: '8.06',
    stakeUsd: '5',
  });
  await db.update(theses).set({ status: 'published', publishedAt: NOW, entryPrice: side === 'yes' ? '0.62' : '0.40' }).where(eq(theses.id, id));
  await db.update(trades).set({ status: 'filled' }).where(eq(trades.thesisId, id));
  return id;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  copier = await createGuestUser(db, 'Copier');
  ({ id: marketId } = await upsertMarket(db, market()));
  const agent = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
  thesisId = await publishedThesis(agent.id, null);
});
afterEach(() => close());

const request = (overrides: object = {}) => {
  seq += 1;
  return { amountUsd: 5, tipUsdc: 0, idempotencyKey: `attempt-${seq}-key`, ...overrides };
};
const copy = (body: unknown, options: Partial<{ now: Date; tradingEnabled: boolean; tipsEnabled: boolean }> = {}, user = copier, id = thesisId) =>
  copyTrade(db, user, id, body, { now: NOW, tradingEnabled: true, tipsEnabled: false, ...options });
const code = async (...args: Parameters<typeof copy>) => {
  const result = await copy(...args);
  return result.ok ? 'ok' : `${result.status} ${result.error.code}`;
};
const balance = async (user = copier) => (await db.select().from(users).where(eq(users.id, user.id)))[0]!.paperBalanceUsd;
const copies = () => db.select().from(trades).where(eq(trades.isAuthorPosition, false));

describe('copyTrade', () => {
  it('buys the thesis’s side at the current price, for whole increments, and locks the position', async () => {
    const result = await copy(request());
    // $5 at 62 cents buys 8.06 contracts for $4.9972.
    expect(result).toMatchObject({
      ok: true,
      data: {
        trade: { side: 'yes', quantity: '8.0600', price: '0.6200', costUsd: '4.9972', status: 'filled' },
        maxLossUsd: '4.9972',
        payoutIfRightUsd: '8.0600',
        tip: { status: 'none' },
        repeated: false,
      },
    });
    expect(await copies()).toMatchObject([
      { userId: copier.id, authorId: null, thesisId, marketId, isAuthorPosition: false, locked: true, mode: 'paper' },
    ]);
    expect(await balance()).toBe('995.0028');
  });

  it('copies a NO thesis at one dollar minus the YES bid', async () => {
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    const fade = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 's' });
    const noThesis = await publishedThesis(fade.id, null, other.id, 'no');
    const result = await copy(request(), {}, copier, noThesis);
    expect(result).toMatchObject({ ok: true, data: { trade: { side: 'no', price: '0.4000' } } });
  });

  it('returns the first result when the same request is repeated, and charges once', async () => {
    const body = request();
    const first = await copy(body);
    const second = await copy(body);
    expect(second).toMatchObject({ ok: true, data: { repeated: true } });
    expect(second.ok && first.ok && second.data.trade.id).toBe(first.ok && first.data.trade.id);
    expect(await copies()).toHaveLength(1);
    expect(await balance()).toBe('995.0028');
  });

  it('makes one trade when the same request arrives twice at once', async () => {
    const body = request();
    const results = await Promise.all([copy(body), copy(body), copy(body)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await copies()).toHaveLength(1);
    expect(await balance()).toBe('995.0028');
  });

  it('rejects over the per-trade cap', async () => {
    expect(await code(request({ amountUsd: 10 }))).toBe('ok');
    expect(await code(request({ amountUsd: 10.01 }))).toBe('409 per_trade_cap');
  });

  it('rejects once the daily cap of $25 would be passed, and says what is left', async () => {
    expect(await code(request({ amountUsd: 10 }))).toBe('ok');
    expect(await code(request({ amountUsd: 10 }))).toBe('ok');
    const third = await copy(request({ amountUsd: 10 }));
    expect(third).toMatchObject({ ok: false, status: 409, error: { code: 'daily_cap' } });
    expect(third.ok ? '' : third.error.message).toContain('left');
    // What is left can still be used.
    expect(await code(request({ amountUsd: 5 }))).toBe('ok');
    expect(await copies()).toHaveLength(3);
  });

  it('asks again with the new price when it has moved more than 5 cents past the author’s entry', async () => {
    await db.update(markets).set({ yesBid: '0.66', yesAsk: '0.68' }).where(eq(markets.id, marketId));
    const result = await copy(request());
    expect(result).toMatchObject({ ok: false, status: 409, error: { code: 'price_moved', price: '0.6800' } });
    expect(await copies()).toHaveLength(0);
    await db.update(markets).set({ yesAsk: '0.67' }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('ok');
  });

  it('will not let an author copy their own thesis', async () => {
    const author = await ensureHumanAuthor(db, copier);
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OWN-X' }));
    const own = await publishedThesis(author.id, copier.id, other.id);
    expect(await code(request(), {}, copier, own)).toBe('409 own_thesis');
  });

  it('is refused when the market is closed, about to close, or nobody is selling', async () => {
    await db.update(markets).set({ expiryAt: new Date(NOW.getTime() + 119_000) }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('409 market_closing');
    await db.update(markets).set({ expiryAt: new Date(NOW.getTime() + 121_000) }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('ok');
    await db.update(markets).set({ yesAsk: null }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('409 no_fill');
    await db.update(markets).set({ marketState: 'closed' }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('409 market_closed');
  });

  it('is refused for a thesis that is not public, or does not exist', async () => {
    await db.update(theses).set({ status: 'blocked' }).where(eq(theses.id, thesisId));
    expect(await code(request())).toBe('404 not_found');
    expect(await code(request(), {}, copier, randomUUID())).toBe('404 not_found');
    expect(await code(request(), {}, copier, 'nonsense')).toBe('404 not_found');
  });

  it('never takes the paper balance below zero', async () => {
    await db.update(users).set({ paperBalanceUsd: '4.00' }).where(eq(users.id, copier.id));
    expect(await code(request({ amountUsd: 5 }))).toBe('409 insufficient_balance');
    expect(await balance()).toBe('4.0000');
    expect(await code(request({ amountUsd: 4 }))).toBe('ok');
    expect(Number(await balance())).toBeGreaterThanOrEqual(0);
  });

  it('rejects a tip over 0.50 USDC, and any tip the thesis cannot take', async () => {
    expect(await code(request({ tipUsdc: 0.51 }), { tipsEnabled: true })).toBe('409 tip_cap');
    // No escrow configured.
    expect(await code(request({ tipUsdc: 0.25 }))).toBe('503 tips_unavailable');
    // Escrow configured, but this thesis was never registered in it.
    expect(await code(request({ tipUsdc: 0.25 }), { tipsEnabled: true })).toBe('503 tips_unavailable');
    expect(await copies()).toHaveLength(0);
    expect(await db.select().from(tips)).toHaveLength(0);
  });

  it('records a tip as pending beside the filled trade, for the worker to send', async () => {
    await db.update(theses).set({ registerTx: '0xregistered' }).where(eq(theses.id, thesisId));
    const result = await copy(request({ tipUsdc: 0.25 }), { tipsEnabled: true });
    expect(result).toMatchObject({ ok: true, data: { trade: { status: 'filled' }, tip: { status: 'pending', amountUsdc: '0.250000' } } });
    expect(await db.select().from(tips)).toMatchObject([
      { thesisId, userId: copier.id, amountUsdc: '0.250000', status: 'pending', circleTxId: null },
    ]);
    // The tip costs test USDC from the wallet, not paper dollars.
    expect(await balance()).toBe('995.0028');
  });

  it('records one tip when a request with a tip is repeated', async () => {
    await db.update(theses).set({ registerTx: '0xregistered' }).where(eq(theses.id, thesisId));
    const body = request({ tipUsdc: 0.5 });
    const first = await copy(body, { tipsEnabled: true });
    const second = await copy(body, { tipsEnabled: true });
    expect(await db.select().from(tips)).toHaveLength(1);
    expect(second.ok && first.ok && second.data.tip.id).toBe(first.ok && first.data.tip.id);
    expect(second).toMatchObject({ ok: true, data: { repeated: true, tip: { status: 'pending' } } });
  });

  it('rejects a malformed request and does nothing while trading is off', async () => {
    expect(await code({ amountUsd: 5 })).toBe('400 invalid');
    expect(await code(request({ amountUsd: 5.001 }))).toBe('400 invalid');
    expect(await code(request(), { tradingEnabled: false })).toBe('503 trading_disabled');
    expect(await copies()).toHaveLength(0);
  });

  it('refuses a price that has stopped updating', async () => {
    await db.update(markets).set({ updatedAt: new Date(NOW.getTime() - 5 * 60_000) }).where(eq(markets.id, marketId));
    expect(await code(request())).toBe('409 stale_price');
  });
});
