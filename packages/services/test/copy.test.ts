import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { authors, chainActions, copyRequests, eq, markets, theses, thesisRegistrations, tips, trades, users, walletAccounts, type Db } from '@thesis/db';
import { createTestDb } from '../../db/src/testing';
import { createGuest, hashContent } from '../src/publication';
import { copyTrade, getCopy, quoteCopy, CopyInput } from '../src/copy';
import { settleCopies } from '../src/chain/worker';
import type { ExecutableQuote } from '../src/human-paper';
const escrow = '0x1111111111111111111111111111111111111111', secret = 'copy-test-secret'.repeat(4);
const now = Date.parse('2026-11-19T18:00:00Z');
let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }); afterAll(() => close());
async function fixture() {
  const authorUser = await createGuest(db, 'Fixture author'), copier = await createGuest(db, 'Fixture copier');
  const [author] = await db.select().from(authors).where(eq(authors.userId, authorUser.id));
  const [market] = await db.insert(markets).values({ instrumentSymbol: `GEMI-FIXTURE-${randomUUID()}`, eventTicker: randomUUID(), contractTicker: 'UP',
    title: 'Fixture only', tracked: true, status: 'active', marketState: 'open', expiryAt: new Date(now + 600_000) }).returning();
  const id = randomUUID();
  const [thesis] = await db.insert(theses).values({ id, onchainId: hashContent(id), authorId: author!.id, marketId: market!.id,
    side: 'yes', probabilityYes: '0.7', headline: 'Fixture forecast', body: 'Fixture only', status: 'published', publishedAt: new Date(now),
    entryPrice: '0.48', contentHash: hashContent('fixture'), registerTx: `0x${'ab'.repeat(32)}` }).returning();
  const key = `fixture-register:${id}`;
  await db.insert(chainActions).values({ key, kind: 'register', walletId: randomUUID(), contractAddress: escrow, status: 'confirmed' });
  await db.insert(thesisRegistrations).values({ thesisId: id, escrowAddress: escrow, authorAddress: '0x2222222222222222222222222222222222222222',
    marketHash: hashContent(market!.id), contentHash: thesis!.contentHash!, expiryAt: market!.expiryAt!, actionKey: key, confirmedAt: new Date(now) });
  await db.insert(walletAccounts).values({ ownerKey: `user:${copier.id}`, userId: copier.id, circleWalletId: randomUUID(),
    address: '0x3333333333333333333333333333333333333333', status: 'ready' });
  const quote: ExecutableQuote = { symbol: market!.instrumentSymbol, bid: 0.48, ask: 0.5, bidSize: 100, askSize: 100,
    observedAtMs: now, marketObservedAtMs: now, status: 'active', marketState: 'open', expiryMs: now + 600_000, quantityIncrement: '0.01', quantityMinimum: '0.01' };
  const token = await quoteCopy(db, id, copier.id, '5', '0.10', quote, { escrowAddress: escrow, secret, now });
  const input = { idempotencyKey: randomUUID(), amountUsd: '5', tipUsdc: '0.10', quoteToken: token.quoteToken, acceptPriceMoved: false };
  const options = { escrowAddress: escrow, secret, enabled: () => true, readQuote: () => quote,
    readFunds: () => ({ ready: true, balance: 2_000_000n, allowance: 20_000_000n, observedAtMs: now }), now: () => now };
  return { authorUser, copier, market: market!, thesis: thesis!, quote, token, input, options };
}
describe('confirmed copy trading', () => {
  it('signs an exact maximum-loss quote and atomically fills one paper copy with one pending tip', async () => {
    const f = await fixture(); expect(f.token).toMatchObject({ maxPaperLossUsd: '5.0000', quantity: '10.0000', priceMoved: false });
    const result = await copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options);
    const [trade] = await db.select().from(trades).where(eq(trades.id, result.tradeId));
    expect(trade).toMatchObject({ authorId: null, isAuthorPosition: false, mode: 'paper', locked: true, costUsd: '5.0000' });
    expect((await getCopy(db, result.id, f.copier.id))?.tip).toMatchObject({ amountUsdc: '0.100000', status: 'pending' });
    expect((await db.select().from(users).where(eq(users.id, f.copier.id)))[0]?.paperBalanceUsd).toBe('995.0000');
  });
  it('replays a completed request without fresh quotes, new debits or extra tips', async () => {
    const f = await fixture(), one = await copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options);
    const two = await copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options, now: () => now + 60_000, enabled: () => false, readQuote: () => null });
    expect(two).toEqual(one);
    expect(await db.select().from(tips).where(eq(tips.tradeId, one.tradeId))).toHaveLength(1);
    await expect(copyTrade(db, f.thesis.id, f.copier.id, { ...f.input, amountUsd: '6' }, f.options)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await getCopy(db, one.id, f.authorUser.id)).toBeNull();
  });
  it('rejects copying an own, unregistered or already-resolved thesis', async () => {
    const f = await fixture();
    await expect(quoteCopy(db, f.thesis.id, f.authorUser.id, '5', '0', f.quote, { escrowAddress: escrow, secret, now })).rejects.toMatchObject({ code: 'own_thesis' });
    await db.update(theses).set({ status: 'resolved' }).where(eq(theses.id, f.thesis.id));
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'thesis_not_copyable' });
    await db.update(theses).set({ status: 'published', registerTx: null }).where(eq(theses.id, f.thesis.id));
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'thesis_not_copyable' });
  });
  it('rejects expired or altered confirmation tokens', async () => {
    const f = await fixture();
    await expect(copyTrade(db, f.thesis.id, f.copier.id, { ...f.input, quoteToken: f.input.quoteToken + 'x' }, f.options)).rejects.toMatchObject({ code: 'quote_expired' });
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options, now: () => now + 30_001 })).rejects.toMatchObject({ code: 'quote_expired' });
    await expect(copyTrade(db, f.thesis.id, f.copier.id, { ...f.input, amountUsd: '6' }, f.options)).rejects.toMatchObject({ code: 'quote_expired' });
  });
  it('requires renewed confirmation when price rises and explicit acceptance above author entry', async () => {
    const f = await fixture();
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options, readQuote: () => ({ ...f.quote, ask: 0.51 }) })).rejects.toMatchObject({ code: 'price_moved' });
    await db.update(theses).set({ entryPrice: '0.40' }).where(eq(theses.id, f.thesis.id));
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'price_moved' });
    expect(await copyTrade(db, f.thesis.id, f.copier.id, { ...f.input, acceptPriceMoved: true }, f.options)).toHaveProperty('tradeId');
  });
  it('rolls back the fill, tip and debit if the book changes during commit', async () => {
    const f = await fixture(); let reads = 0;
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options,
      readQuote: () => (++reads === 1 ? f.quote : { ...f.quote, askSize: 1 }) })).rejects.toMatchObject({ code: 'quote_changed' });
    expect(await getCopy(db, f.input.idempotencyKey, f.copier.id)).toBeNull();
    expect((await db.select().from(users).where(eq(users.id, f.copier.id)))[0]?.paperBalanceUsd).toBe('1000.0000');
  });
  it('enforces live data age, daily/per-trade limits, paper balance and kill switch', async () => {
    for (const mode of ['stale', 'daily', 'per-trade', 'balance', 'disabled']) {
      const f = await fixture();
      if (mode === 'daily') await db.update(users).set({ dailyCopyCapUsd: '4' }).where(eq(users.id, f.copier.id));
      if (mode === 'per-trade') await db.update(users).set({ maxPerTradeUsd: '4' }).where(eq(users.id, f.copier.id));
      if (mode === 'balance') await db.update(users).set({ paperBalanceUsd: '1' }).where(eq(users.id, f.copier.id));
      await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options, enabled: () => mode !== 'disabled',
        readQuote: () => mode === 'stale' ? { ...f.quote, observedAtMs: now - 10_001 } : f.quote })).rejects.toThrow();
      expect(await getCopy(db, f.input.idempotencyKey, f.copier.id)).toBeNull();
    }
  });
  it('reserves pending tips and enforces the app and lifetime per-thesis tip caps', async () => {
    const f = await fixture();
    expect(CopyInput.safeParse({ ...f.input, tipUsdc: '0.500001' }).success).toBe(false);
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, { ...f.options, readFunds: () => ({ ready: true, balance: 0n, allowance: 20_000_000n, observedAtMs: now }) })).rejects.toMatchObject({ code: 'insufficient_usdc' });
    await db.insert(tips).values({ thesisId: f.thesis.id, userId: f.copier.id, amountUsdc: '1.95', status: 'pending' });
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'insufficient_usdc' });
    await db.update(tips).set({ amountUsdc: '5', status: 'paid' }).where(eq(tips.userId, f.copier.id));
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'tip_limit' });
  });
  it('supports a no-tip copy without creating a Circle wallet or deposit', async () => {
    const f = await fixture(); await db.update(walletAccounts).set({ status: 'queued' }).where(eq(walletAccounts.userId, f.copier.id));
    await expect(copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options)).rejects.toMatchObject({ code: 'wallet_not_ready' });
    const quote = await quoteCopy(db, f.thesis.id, f.copier.id, '5', '0', f.quote, { escrowAddress: escrow, secret, now });
    const result = await copyTrade(db, f.thesis.id, f.copier.id, { ...f.input, tipUsdc: '0', quoteToken: quote.quoteToken }, f.options);
    expect(result.tipId).toBeNull();
  });
  it('settles only from the exact official contract and credits copies once', async () => {
    const f = await fixture(); const copy = await copyTrade(db, f.thesis.id, f.copier.id, f.input, f.options);
    expect(await settleCopies(db, { getEvent: async () => null }, now + 700_000)).toBe(0);
    const client = { getEvent: async (ticker: string) => ticker === f.market.eventTicker ? { ticker, title: 'Fixture', status: 'settled', contracts: [{ ticker: 'UP', instrumentSymbol: f.market.instrumentSymbol, resolutionSide: 'yes' as const }] } : null };
    expect(await settleCopies(db, client, now + 700_000)).toBe(1); expect(await settleCopies(db, client, now + 700_000)).toBe(0);
    expect((await getCopy(db, copy.id, f.copier.id))?.trade).toMatchObject({ status: 'settled', payoutUsd: '10.0000' });
    expect((await db.select().from(users).where(eq(users.id, f.copier.id)))[0]?.paperBalanceUsd).toBe('1005.0000');
  });
});
