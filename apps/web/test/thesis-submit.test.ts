import { createGuestUser, eq, markets, theses, trades, upsertMarket, users, type Db, type MarketUpsert, type UserRow } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { submitThesis } from '../lib/thesis-submit';

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
  yesBid: '0.51',
  yesAsk: '0.55',
  lastPrice: '0.57',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

const body = (overrides: object = {}) => ({
  symbol: SYMBOL,
  side: 'yes',
  probabilityYes: 0.7,
  stakeUsd: 5,
  headline: 'Inventories are drawing faster than the curve implies',
  body: 'US crude stocks fell for three straight weeks.',
  evidence: [{ claim: 'EIA weekly report', url: 'https://www.eia.gov/petroleum/supply/weekly/' }],
  ...overrides,
});

let db: Db;
let close: () => Promise<void>;
let user: UserRow;
let marketId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  user = await createGuestUser(db, 'Sam');
  ({ id: marketId } = await upsertMarket(db, market()));
});
afterEach(() => close());

const submit = (value: unknown, options: Partial<{ now: Date; tradingEnabled: boolean }> = {}) =>
  submitThesis(db, user, value, { now: NOW, tradingEnabled: true, ...options });
const code = async (value: unknown, options: Partial<{ now: Date; tradingEnabled: boolean }> = {}) => {
  const result = await submit(value, options);
  return result.ok ? 'ok' : `${result.status} ${result.error.code}`;
};

describe('submitThesis', () => {
  it('stores a valid thesis for the auditor, with the author’s intended position, and charges nothing', async () => {
    const result = await submit(body());
    expect(result).toMatchObject({ ok: true, data: { status: 'auditing' } });
    const [thesis] = await db.select().from(theses);
    expect(thesis).toMatchObject({ status: 'auditing', side: 'yes', probabilityYes: '0.7000', marketId });
    expect(thesis!.onchainId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(thesis!.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Price shown 55 cents: it may fill up to 60, five cents of slippage.
    expect((await db.select().from(trades))[0]).toMatchObject({
      status: 'pending',
      userId: user.id,
      isAuthorPosition: true,
      price: '0.6000',
      costUsd: '5.0000',
      quantity: '9.0900',
    });
    expect((await db.select().from(users))[0]!.paperBalanceUsd).toBe('1000.0000');
  });

  it('never lets the fill price exceed the author’s own probability for the side', async () => {
    await submit(body({ probabilityYes: 0.57 }));
    expect((await db.select().from(trades))[0]!.price).toBe('0.5700');
  });

  it('caps a NO position the same way', async () => {
    // NO costs 49 cents. The author puts NO at 52%, so it may fill up to 52, not 54.
    await submit(body({ side: 'no', probabilityYes: 0.48 }));
    expect((await db.select().from(trades))[0]).toMatchObject({ side: 'no', price: '0.5200' });
  });

  it('rejects a thesis that breaks the format, naming the field', async () => {
    const result = await submit(body({ headline: 'x'.repeat(91) }));
    expect(result).toMatchObject({ ok: false, status: 400, error: { code: 'invalid' } });
    expect(result.ok ? '' : result.error.message).toContain('headline');
    expect(await code(body({ evidence: [] }))).toBe('400 invalid');
    expect(await code(body({ stakeUsd: 0.5 }))).toBe('400 invalid');
    expect(await code('not an object')).toBe('400 invalid');
    expect(await db.select().from(theses)).toHaveLength(0);
  });

  it('rejects a side the author’s own probability does not support', async () => {
    const result = await submit(body({ probabilityYes: 0.4 }));
    expect(result).toMatchObject({ ok: false, status: 409, error: { code: 'side_mismatch' } });
    expect(result.ok ? '' : result.error.message).toContain('YES at 40%');
  });

  it('rejects an unknown market, a closed one, and one about to close', async () => {
    expect(await code(body({ symbol: 'GEMI-NOPE-X' }))).toBe('404 not_found');
    await db.update(markets).set({ marketState: 'closed' }).where(eq(markets.id, marketId));
    expect(await code(body())).toBe('409 market_closed');
    await db.update(markets).set({ marketState: 'open', expiryAt: new Date(NOW.getTime() + 4 * 60_000) }).where(eq(markets.id, marketId));
    expect(await code(body())).toBe('409 market_closing');
    await db.update(markets).set({ expiryAt: new Date(NOW.getTime() + 5 * 60_000) }).where(eq(markets.id, marketId));
    expect(await code(body())).toBe('ok');
  });

  it('holds the stake to the per-trade limit and the paper balance', async () => {
    expect(await code(body({ stakeUsd: 10 }))).toBe('ok');
    await db.delete(trades);
    await db.delete(theses);
    expect(await code(body({ stakeUsd: 10.01 }))).toBe('400 over_limit');
    await db.update(users).set({ paperBalanceUsd: '4.99' });
    user = (await db.select().from(users))[0]!;
    expect(await code(body({ stakeUsd: 5 }))).toBe('409 insufficient_balance');
  });

  it('allows one thesis per author per market, and one audit at a time', async () => {
    expect(await code(body())).toBe('ok');
    expect(await code(body())).toBe('409 already_published');
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    expect(other.id).toBeTruthy();
    expect(await code(body({ symbol: 'GEMI-OTHER-X' }))).toBe('409 audit_in_progress');
    // Once the first is published, a thesis on another market is fine.
    await db.update(theses).set({ status: 'published' });
    expect(await code(body({ symbol: 'GEMI-OTHER-X' }))).toBe('ok');
    expect(await code(body())).toBe('409 already_published');
  });

  it('lets only one of several simultaneous submissions through', async () => {
    const results = await Promise.all([submit(body()), submit(body()), submit(body())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.status === 409)).toBe(true);
    expect(await db.select().from(theses)).toHaveLength(1);
    expect(await db.select().from(trades)).toHaveLength(1);
  });

  it('allows twenty theses a day per author, then asks them to come back tomorrow', async () => {
    for (let i = 0; i < 20; i += 1) {
      await upsertMarket(db, market({ instrumentSymbol: `GEMI-DAY-${i}` }));
      expect(await code(body({ symbol: `GEMI-DAY-${i}` }))).toBe('ok');
      await db.update(theses).set({ status: 'published' });
    }
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-DAY-20' }));
    expect(await code(body({ symbol: 'GEMI-DAY-20' }))).toBe('429 daily_limit');
  });

  it('refuses to price a thesis off a quote that has stopped updating', async () => {
    await db.update(markets).set({ updatedAt: new Date(NOW.getTime() - 5 * 60_000) }).where(eq(markets.id, marketId));
    expect(await code(body())).toBe('409 stale_price');
  });

  it('lets an author try again after a thesis was blocked or sent back', async () => {
    await submit(body());
    await db.update(theses).set({ status: 'blocked' });
    await db.update(trades).set({ status: 'rejected' });
    expect(await code(body())).toBe('ok');
  });

  it('accepts nothing while trading is switched off', async () => {
    expect(await code(body(), { tradingEnabled: false })).toBe('503 trading_disabled');
  });
});
