import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentState,
  applyDueLimits,
  createAuditingThesis,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  getAccount,
  getActivity,
  getAuthorStanding,
  getAuthorTheses,
  getLeaderboard,
  getUserById,
  markets,
  requestLimits,
  theses,
  tips,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
  type NewThesis,
} from '../src/index';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

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

/**
 * One thesis with its author's position, in the state given. A resolved one has its
 * position settled with the payout given.
 */
async function thesis(
  authorId: string,
  options: {
    userId?: string;
    outcome?: 'right' | 'wrong';
    costUsd?: string;
    payoutUsd?: string;
    status?: 'auditing' | 'published';
    resolvedAt?: Date;
  } = {},
): Promise<{ id: string; marketId: string }> {
  const { id: marketId } = await upsertMarket(db, market(`GEMI-T-${seq + 1}`));
  const id = uuid();
  const row: NewThesis = {
    id,
    onchainId: `0xon${id}`,
    contentHash: `0xhash${id}`,
    authorId,
    userId: options.userId ?? null,
    marketId,
    side: 'yes',
    probabilityYes: '0.7',
    headline: `Headline ${id.slice(-3)}`,
    body: 'Body',
    evidence: [{ claim: 'c', url: 'https://example.com' }],
    limitPrice: '0.60',
    quantity: '10',
    stakeUsd: options.costUsd ?? '5',
  };
  await createAuditingThesis(db, row);
  if (options.status === 'auditing') return { id, marketId };
  const resolved = options.outcome !== undefined;
  await db
    .update(theses)
    .set({
      status: resolved ? 'resolved' : 'published',
      outcome: options.outcome ?? null,
      publishedAt: new Date('2026-11-18T12:00:00Z'),
      entryPrice: '0.55',
      marketYesPriceAtPublish: '0.55',
    })
    .where(eq(theses.id, id));
  await db
    .update(trades)
    .set({
      status: resolved ? 'settled' : 'filled',
      costUsd: options.costUsd ?? '5',
      payoutUsd: resolved ? (options.payoutUsd ?? '0') : null,
    })
    .where(eq(trades.thesisId, id));
  if (resolved) {
    await db
      .update(markets)
      .set({ resolvedAt: options.resolvedAt ?? new Date('2026-11-18T22:05:00Z') })
      .where(eq(markets.id, marketId));
  }
  return { id, marketId };
}

const agent = (key: string) => ensureAgentAuthor(db, { agentKey: key, displayName: key, strategySummary: `${key} strategy` });

describe('getLeaderboard', () => {
  it('lists each author with a public thesis, with their record, profit and thesis count', async () => {
    const news = await agent('news');
    const fade = await agent('fade');
    const silent = await agent('momentum');
    // news: won 10 on 5, lost 4. Profit 5 - 4 = 1. One more still open.
    await thesis(news.id, { outcome: 'right', costUsd: '5', payoutUsd: '10' });
    await thesis(news.id, { outcome: 'wrong', costUsd: '4', payoutUsd: '0' });
    await thesis(news.id);
    // fade: one open thesis, nothing resolved.
    await thesis(fade.id);
    // momentum: only a thesis still being audited, which is not public.
    await thesis(silent.id, { status: 'auditing' });

    const board = await getLeaderboard(db);
    expect(board.map((row) => row.author.agentKey).sort()).toEqual(['fade', 'news']);
    const byKey = new Map(board.map((row) => [row.author.agentKey, row]));
    expect(byKey.get('news')).toMatchObject({
      theses: 3,
      profitUsd: '1.0000',
      record: { resolved: 2, right: 1 },
    });
    expect(byKey.get('fade')).toMatchObject({
      theses: 1,
      profitUsd: '0.0000',
      record: { resolved: 0, right: 0, brier: null },
    });
  });

  it('counts only the author’s own position toward profit, not copies of their thesis', async () => {
    const news = await agent('news');
    const { id, marketId } = await thesis(news.id, { outcome: 'right', costUsd: '5', payoutUsd: '10' });
    const copier = await createGuestUser(db, 'Copier');
    await db.insert(trades).values({
      userId: copier.id,
      marketId,
      thesisId: id,
      isAuthorPosition: false,
      side: 'yes',
      quantity: '100',
      price: '0.55',
      costUsd: '55',
      payoutUsd: '100',
      mode: 'paper',
      status: 'settled',
      idempotencyKey: 'copy:1',
    });
    const [row] = await getLeaderboard(db);
    expect(row?.profitUsd).toBe('5.0000');
  });
});

describe('getAuthorStanding and getAuthorTheses', () => {
  it('returns null for an author that does not exist', async () => {
    expect(await getAuthorStanding(db, '00000000-0000-4000-8000-999999999999', new Date())).toBeNull();
  });

  it('describes an author who has published nothing, without inventing a record', async () => {
    const user = await createGuestUser(db, 'Sam');
    const author = await ensureHumanAuthor(db, user);
    const standing = await getAuthorStanding(db, author.id, new Date());
    expect(standing).toMatchObject({
      theses: 0,
      profitUsd: '0.0000',
      record: { resolved: 0, brier: null },
      agentStatus: null,
    });
  });

  it('reports an agent’s day, including a halt and its reason', async () => {
    const news = await agent('news');
    await thesis(news.id);
    const now = new Date('2026-11-19T10:00:00Z');
    expect((await getAuthorStanding(db, news.id, now))?.agentStatus).toEqual({
      halted: false,
      haltReason: null,
      tradesToday: 0,
      realizedPnlTodayUsd: '0.0000',
      openExposureUsd: '0.0000',
    });
    await db.insert(agentState).values([
      // Yesterday's halt must not carry into today.
      { agentKey: 'news', day: '2026-11-18', halted: true, haltReason: 'daily loss stop' },
      { agentKey: 'news', day: '2026-11-19', tradeCount: 4, realizedPnlUsd: '-51', openExposureUsd: '20', halted: true, haltReason: 'daily loss stop' },
    ]);
    expect((await getAuthorStanding(db, news.id, now))?.agentStatus).toEqual({
      halted: true,
      haltReason: 'daily loss stop',
      tradesToday: 4,
      realizedPnlTodayUsd: '-51.0000',
      openExposureUsd: '20.0000',
    });
    expect((await getAuthorStanding(db, news.id, new Date('2026-11-20T00:00:01Z')))?.agentStatus?.halted).toBe(false);
  });

  it('lists an author’s public theses only', async () => {
    const news = await agent('news');
    const fade = await agent('fade');
    const open = await thesis(news.id);
    const done = await thesis(news.id, { outcome: 'right', payoutUsd: '10' });
    await thesis(news.id, { status: 'auditing' });
    await thesis(fade.id);
    const views = await getAuthorTheses(db, news.id);
    expect(views.map((view) => view.thesis.id).sort()).toEqual([open.id, done.id].sort());
  });
});

describe('getActivity', () => {
  it('lists paid and refunded tips, the latest resolution first, and leaves the rest out', async () => {
    const news = await agent('news');
    const tipper = await createGuestUser(db, 'Tipper');
    const right = await thesis(news.id, { outcome: 'right', payoutUsd: '10', resolvedAt: new Date('2026-11-18T22:05:00Z') });
    const wrong = await thesis(news.id, { outcome: 'wrong', resolvedAt: new Date('2026-11-18T23:05:00Z') });
    const open = await thesis(news.id);
    await db.insert(tips).values([
      { thesisId: right.id, userId: tipper.id, amountUsdc: '0.25', status: 'paid', settleTx: '0xpaid' },
      { thesisId: wrong.id, userId: tipper.id, amountUsdc: '0.10', status: 'refunded', settleTx: '0xrefund' },
      { thesisId: open.id, userId: tipper.id, amountUsdc: '0.50', status: 'escrowed' },
      { thesisId: open.id, userId: tipper.id, amountUsdc: '0.50', status: 'failed' },
    ]);
    const items = await getActivity(db);
    expect(items.map((item) => [item.status, item.amountUsdc, item.outcome, item.settleTx])).toEqual([
      ['refunded', '0.100000', 'wrong', '0xrefund'],
      ['paid', '0.250000', 'right', '0xpaid'],
    ]);
    expect(items[0]).toMatchObject({ authorName: 'news', thesisId: wrong.id });
    expect(items[0]?.at.toISOString()).toBe('2026-11-18T23:05:00.000Z');
    expect(await getActivity(db, 1)).toHaveLength(1);
  });
});

describe('getAccount', () => {
  it('returns a user’s own and copied positions and their tips, and nobody else’s', async () => {
    const user = await createGuestUser(db, 'Sam');
    const other = await createGuestUser(db, 'Other');
    const author = await ensureHumanAuthor(db, user);
    const news = await agent('news');
    const mine = await thesis(author.id, { userId: user.id });
    const theirs = await thesis(news.id);
    await thesis(author.id, { userId: user.id, status: 'auditing' });
    const copy = {
      marketId: theirs.marketId,
      thesisId: theirs.id,
      isAuthorPosition: false,
      side: 'yes' as const,
      quantity: '5',
      price: '0.55',
      costUsd: '2.75',
      mode: 'paper' as const,
    };
    await db.insert(trades).values([
      { ...copy, userId: user.id, status: 'filled', idempotencyKey: 'copy:mine' },
      { ...copy, userId: user.id, status: 'rejected', idempotencyKey: 'copy:rejected' },
      { ...copy, userId: other.id, status: 'filled', idempotencyKey: 'copy:other' },
    ]);
    await db.insert(tips).values([
      { thesisId: theirs.id, userId: user.id, amountUsdc: '0.25', status: 'escrowed', depositTx: '0xdeposit' },
      { thesisId: theirs.id, userId: other.id, amountUsdc: '0.50', status: 'escrowed' },
    ]);

    const account = await getAccount(db, user.id);
    // The pending trade behind the thesis still being audited, and the rejected copy, are not positions.
    expect(account.positions.map((p) => [p.thesisId, p.isAuthorPosition, p.status]).sort()).toEqual(
      [
        [mine.id, true, 'filled'],
        [theirs.id, false, 'filled'],
      ].sort(),
    );
    expect(account.tips).toHaveLength(1);
    expect(account.tips[0]).toMatchObject({ thesisId: theirs.id, amountUsdc: '0.250000', status: 'escrowed', depositTx: '0xdeposit' });
  });
});

describe('limits: lowering applies at once, raising waits for the next UTC day', () => {
  const evening = new Date('2026-11-19T23:30:00Z');

  it('applies a lower limit immediately', async () => {
    const user = await createGuestUser(db, 'Sam');
    const updated = await requestLimits(db, user, { maxPerTradeUsd: '5.00', dailyCopyCapUsd: '10.00' }, evening);
    expect(updated).toMatchObject({ maxPerTradeUsd: '5.0000', dailyCopyCapUsd: '10.0000', pendingLimits: null });
  });

  it('holds a raise until the next UTC day, then applies it once', async () => {
    const user = await createGuestUser(db, 'Sam');
    const waiting = await requestLimits(db, user, { dailyCopyCapUsd: '60.00' }, evening);
    expect(waiting).toMatchObject({
      dailyCopyCapUsd: '25.0000',
      pendingLimits: { dailyCopyCapUsd: '60.00', effectiveOn: '2026-11-20' },
    });

    // One minute before midnight UTC nothing changes.
    const before = await applyDueLimits(db, waiting, new Date('2026-11-19T23:59:00Z'));
    expect(before.dailyCopyCapUsd).toBe('25.0000');
    // At midnight it does.
    const after = await applyDueLimits(db, before, new Date('2026-11-20T00:00:00Z'));
    expect(after).toMatchObject({ dailyCopyCapUsd: '60.0000', maxPerTradeUsd: '10.0000', pendingLimits: null });
    expect(await getUserById(db, user.id)).toMatchObject({ dailyCopyCapUsd: '60.0000', pendingLimits: null });
    // Applying again is a no-op.
    expect(await applyDueLimits(db, after, new Date('2026-11-21T00:00:00Z'))).toEqual(after);
  });

  it('handles a lower and a higher limit in one request', async () => {
    const user = await createGuestUser(db, 'Sam');
    const updated = await requestLimits(db, user, { maxPerTradeUsd: '2.00', dailyCopyCapUsd: '50.00' }, evening);
    expect(updated).toMatchObject({
      maxPerTradeUsd: '2.0000',
      dailyCopyCapUsd: '25.0000',
      pendingLimits: { dailyCopyCapUsd: '50.00', effectiveOn: '2026-11-20' },
    });
    expect(updated.pendingLimits).not.toHaveProperty('maxPerTradeUsd');
  });

  it('withdraws a waiting raise when the user then asks for a lower limit', async () => {
    const user = await createGuestUser(db, 'Sam');
    const waiting = await requestLimits(db, user, { dailyCopyCapUsd: '60.00' }, evening);
    const lowered = await requestLimits(db, waiting, { dailyCopyCapUsd: '15.00' }, evening);
    expect(lowered).toMatchObject({ dailyCopyCapUsd: '15.0000', pendingLimits: null });
    expect((await applyDueLimits(db, lowered, new Date('2026-11-20T00:00:00Z'))).dailyCopyCapUsd).toBe('15.0000');
  });

  it('treats a limit raised back up after being lowered as a raise', async () => {
    const user = await createGuestUser(db, 'Sam');
    const lowered = await requestLimits(db, user, { maxPerTradeUsd: '3.00' }, evening);
    const raised = await requestLimits(db, lowered, { maxPerTradeUsd: '10.00' }, evening);
    expect(raised).toMatchObject({
      maxPerTradeUsd: '3.0000',
      pendingLimits: { maxPerTradeUsd: '10.00', effectiveOn: '2026-11-20' },
    });
  });
});
