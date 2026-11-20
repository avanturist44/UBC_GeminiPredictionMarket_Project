import { ARENA_ROSTER } from '@thesis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, authors, ensureAgentAuthor, eq, getArenaData, sandboxOrders, theses, trades, upsertMarket, type Db, type MarketUpsert } from '../src';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const NOW = new Date('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
const OPTS = { now: NOW, slots: 10, runsPerAgent: 2 };

const market: MarketUpsert = {
  instrumentSymbol: 'GEMI-BRENT-HI90',
  eventTicker: 'BRENT2611192200',
  contractTicker: 'HI90',
  title: 'Oil (Brent) price on November 19?',
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
};

const arenaAuthor = (id: 'gemini' | 'claude' | 'gpt' | 'grok' | 'deepseek') =>
  ensureAgentAuthor(db, { agentKey: `arena-${id}`, displayName: `Old name for ${id}`, strategySummary: 's' });

describe('getArenaData', () => {
  it('reads every roster model, in roster order, each with its own positions', async () => {
    const gpt = await arenaAuthor('gpt');
    const { id: marketId } = await upsertMarket(db, market);
    await db.insert(trades).values({
      authorId: gpt.id,
      marketId,
      isAuthorPosition: true,
      side: 'yes',
      quantity: '10',
      price: '0.50',
      costUsd: '5.0000',
      mode: 'paper',
      status: 'filled',
      idempotencyKey: 'k1',
      createdAt: at(60),
    });

    const data = await getArenaData(db, OPTS);
    expect(data.agents.map((a) => a.agentKey)).toEqual(ARENA_ROSTER.map((e) => e.agentKey));
    expect(data.agents.find((a) => a.agentKey === 'arena-gpt')!.trades).toHaveLength(1);
    expect(data.agents.filter((a) => a.trades.length > 0)).toHaveLength(1);
    expect(data.since?.toISOString()).toBe(at(60).toISOString());
    expect(data.markets.map((m) => m.instrumentSymbol)).toEqual(['GEMI-BRENT-HI90']);
  });

  it('reads the sandbox order of each trade, and only its outcome', async () => {
    const gpt = await arenaAuthor('gpt');
    const { id: marketId } = await upsertMarket(db, market);
    const base = { authorId: gpt.id, marketId, isAuthorPosition: true, side: 'yes' as const, quantity: '10', price: '0.50', costUsd: '5.0000', mode: 'paper' as const, status: 'filled' as const };
    const [mirrored, bare] = await db
      .insert(trades)
      .values([
        { ...base, idempotencyKey: 'k1', createdAt: at(60) },
        { ...base, idempotencyKey: 'k2', createdAt: at(50) },
      ])
      .returning();
    await db.insert(sandboxOrders).values({
      tradeId: mirrored!.id,
      agentKey: 'arena-gpt',
      clientOrderId: mirrored!.id,
      status: 'filled',
      orderId: 'secret-order',
      sandboxPrice: '0.5500',
      filledQuantity: '10.0000',
    });

    const data = await getArenaData(db, OPTS);
    expect(data.exchanges.get(mirrored!.id)).toEqual({ status: 'filled', filledQuantity: '10.0000', sandboxPrice: '0.5500' });
    expect(data.exchanges.has(bare!.id)).toBe(false);
  });

  it('keeps each model’s latest runs, newest first, with the thesis headline and search suggestions', async () => {
    const gemini = await arenaAuthor('gemini');
    const { id: marketId } = await upsertMarket(db, market);
    const [thesis] = await db
      .insert(theses)
      .values({
        onchainId: `0x${'1'.padStart(64, '0')}`,
        authorId: gemini.id,
        marketId,
        side: 'yes',
        probabilityYes: '0.72',
        headline: 'Brent holds above $90 into the close',
        body: 'Body',
        status: 'auditing',
      })
      .returning();
    await db.insert(agentRuns).values([
      { agentKey: 'arena-gemini', marketId, decision: 'skip', reason: 'Oldest look.', createdAt: at(180) },
      {
        agentKey: 'arena-gemini',
        marketId,
        decision: 'trade',
        reason: 'Puts YES at 72%, 17 points from the price. Thesis sent to the auditor.',
        signal: { probabilityYes: 0.72, thesisId: thesis!.id, searchSuggestionsHtml: '<div class="chip">brent close</div>' },
        createdAt: at(120),
      },
      { agentKey: 'arena-gemini', decision: 'skip', reason: 'An earlier thesis is still with the auditor.', createdAt: at(60) },
      // After the moment being read: not part of it.
      { agentKey: 'arena-gemini', decision: 'skip', reason: 'From the future.', createdAt: new Date(NOW.getTime() + 60_000) },
      { agentKey: 'arena-claude', decision: 'skip', reason: 'Claude’s look.', signal: { thesisId: 'not-a-uuid' }, createdAt: at(30) },
    ]);

    const data = await getArenaData(db, OPTS);
    const runs = data.runs.get('arena-gemini')!;
    expect(runs.map((r) => r.reason)).toEqual([
      'An earlier thesis is still with the auditor.',
      'Puts YES at 72%, 17 points from the price. Thesis sent to the auditor.',
    ]);
    expect(runs[0]).toMatchObject({ decision: 'skip', marketTitle: null, thesisHeadline: null, searchSuggestionsHtml: null });
    expect(runs[1]).toMatchObject({
      decision: 'trade',
      marketTitle: 'Oil (Brent) price on November 19?',
      contractLabel: '$90 or above',
      thesisHeadline: 'Brent holds above $90 into the close',
      searchSuggestionsHtml: '<div class="chip">brent close</div>',
    });
    expect(runs[1]!.createdAt.toISOString()).toBe(at(120).toISOString());
    // A thesis id that is not a uuid finds no thesis rather than failing the read.
    expect(data.runs.get('arena-claude')!.map((r) => [r.reason, r.thesisHeadline])).toEqual([['Claude’s look.', null]]);
    expect(data.runs.get('arena-deepseek')).toEqual([]);
  });

  it('gives each model its payout wallet, or null before it has one', async () => {
    const claude = await arenaAuthor('claude');
    await arenaAuthor('gpt');
    await db.update(authors).set({ walletAddress: '0xabc0000000000000000000000000000000000001' }).where(eq(authors.id, claude.id));

    const data = await getArenaData(db, OPTS);
    expect(Object.fromEntries(data.wallets)).toEqual({
      'arena-gemini': null,
      'arena-claude': '0xabc0000000000000000000000000000000000001',
      'arena-gpt': null,
      'arena-grok': null,
      'arena-deepseek': null,
    });
  });
});
