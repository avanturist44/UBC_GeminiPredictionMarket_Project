import { createLlm, thesisContentHash, thesisOnchainId, type LlmCompletion, type LlmRequest } from '@thesis/core';
import {
  agentRuns,
  agentState,
  audits,
  createAuditingThesis,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  getUserById,
  markets,
  sql,
  theses,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThesisPipeline, type BookQuote, type PipelineDeps } from '../src/thesis-pipeline';

const SYMBOL = 'GEMI-BRENT2611182200-HI90';
const NOW = new Date('2026-11-18T05:00:00Z');

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

/** A model that replies with queued text. An empty queue means it must not be called. */
function scripted(replies: Array<string | Error>) {
  const requests: LlmRequest[] = [];
  const llm = createLlm({
    provider: {
      model: 'test-model',
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        requests.push(request);
        const next = replies.shift();
        if (next === undefined) throw new Error('no reply scripted');
        if (next instanceof Error) throw next;
        return { text: next, model: 'test-model', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    },
  });
  return { llm, requests };
}
const CLEAN = JSON.stringify({ inside_info: false, inside_info_quote: null, prohibited: 'none', claims: [] });
const withClaim = JSON.stringify({
  inside_info: false,
  inside_info_quote: null,
  prohibited: 'none',
  claims: [{ text: 'OPEC cut output by 5 million barrels yesterday', kind: 'other', value: null }],
});
const contradicted = JSON.stringify({
  results: [{ index: 1, status: 'contradicted', source_url: 'https://www.reuters.com/x', note: 'No cut was announced.' }],
});

let db: Db;
let close: () => Promise<void>;
let marketId: string;
let now: Date;
let enabled: boolean;
let book: BookQuote | undefined;
const logs: string[] = [];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ id: marketId } = await upsertMarket(db, market()));
  now = NOW;
  enabled = true;
  book = undefined;
  logs.length = 0;
});
afterEach(() => close());

function pipeline(llm: PipelineDeps['llm']) {
  return createThesisPipeline({
    db,
    llm,
    book: () => book,
    tradingEnabled: () => enabled,
    now: () => now,
    logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
}

interface Submit {
  side?: 'yes' | 'no';
  probabilityYes?: number;
  body?: string;
  limitPrice?: string;
  stakeUsd?: string;
}

async function submit(author: { id: string }, userId: string | null, input: Submit = {}): Promise<string> {
  const id = randomUUID();
  const side = input.side ?? 'yes';
  const probabilityYes = input.probabilityYes ?? 0.7;
  const content = {
    headline: 'Inventories are drawing faster than the curve implies',
    body: input.body ?? 'US crude stocks fell for three straight weeks.',
    evidence: [{ claim: 'EIA weekly report', url: 'https://www.eia.gov/petroleum/supply/weekly/' }],
  };
  await createAuditingThesis(db, {
    id,
    onchainId: thesisOnchainId(id),
    contentHash: thesisContentHash({ market: SYMBOL, side, probabilityYes, ...content }),
    authorId: author.id,
    userId,
    marketId,
    side,
    probabilityYes: probabilityYes.toFixed(4),
    ...content,
    limitPrice: input.limitPrice ?? '0.60',
    quantity: '9.09',
    stakeUsd: input.stakeUsd ?? '5',
  });
  return id;
}

async function person(name = 'Sam') {
  const user = await createGuestUser(db, name);
  return { user, author: await ensureHumanAuthor(db, user) };
}
const agent = (agentKey = 'news') =>
  ensureAgentAuthor(db, { agentKey, displayName: agentKey, strategySummary: 'test' });

const thesisOf = async (id: string) => (await db.select().from(theses).where(eq(theses.id, id)))[0]!;
const tradeOf = async (id: string) => (await db.select().from(trades).where(eq(trades.thesisId, id)))[0]!;
const auditsOf = (id: string) => db.select().from(audits).where(eq(audits.thesisId, id));

describe('a person’s thesis', () => {
  it('is audited, filled at the current price and published', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    const { llm } = scripted([CLEAN]);
    expect(await pipeline(llm).runCycle()).toEqual({ published: 1, blocked: 0, returned: 0, waiting: 0, backfilled: 0 });

    const thesis = await thesisOf(id);
    expect(thesis).toMatchObject({ status: 'published', entryPrice: '0.5500', marketYesPriceAtPublish: '0.5300' });
    expect(thesis.publishedAt?.toISOString()).toBe(NOW.toISOString());
    // $5 at 55 cents: 9.09 contracts for $4.9995.
    expect(await tradeOf(id)).toMatchObject({
      status: 'filled',
      quantity: '9.0900',
      price: '0.5500',
      costUsd: '4.9995',
      locked: true,
      isAuthorPosition: true,
      rejectReason: null,
    });
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('995.0005');
    expect(await auditsOf(id)).toMatchObject([{ verdict: 'pass', insideInfo: false, model: 'test-model' }]);
  });

  it('buys NO at one dollar minus the YES bid', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id, { side: 'no', probabilityYes: 0.3, limitPrice: '0.55' });
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await tradeOf(id)).toMatchObject({ status: 'filled', side: 'no', price: '0.4900' });
    expect(await thesisOf(id)).toMatchObject({ status: 'published', entryPrice: '0.4900' });
  });

  it('is blocked for claiming inside knowledge: not published, no trade, no charge', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id, { body: 'A friend at the refinery told me output is about to drop.' });
    const { llm, requests } = scripted([]);
    expect(await pipeline(llm).runCycle()).toMatchObject({ blocked: 1, published: 0 });

    expect(await thesisOf(id)).toMatchObject({ status: 'blocked', publishedAt: null, entryPrice: null });
    const trade = await tradeOf(id);
    expect(trade.status).toBe('rejected');
    expect(trade.rejectReason).toContain('inside or non-public knowledge');
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
    expect(await auditsOf(id)).toMatchObject([{ verdict: 'blocked', insideInfo: true }]);
    expect(requests).toHaveLength(0);
  });

  it('is published with a flag when a claim is contradicted, and the claim is kept for readers', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id, { body: 'OPEC cut output by 5 million barrels yesterday.' });
    await pipeline(scripted([withClaim, contradicted]).llm).runCycle();

    expect(await thesisOf(id)).toMatchObject({ status: 'published' });
    const [audit] = await auditsOf(id);
    expect(audit).toMatchObject({ verdict: 'flagged' });
    expect(audit!.claims).toEqual([
      {
        text: 'OPEC cut output by 5 million barrels yesterday',
        status: 'contradicted',
        source_url: 'https://www.reuters.com/x',
        note: 'No cut was announced.',
      },
    ]);
  });

  it('goes back to draft, uncharged, when the price has moved past the author’s limit', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id, { limitPrice: '0.60' });
    await db.update(markets).set({ yesBid: '0.60', yesAsk: '0.64' }).where(eq(markets.id, marketId));
    expect(await pipeline(scripted([CLEAN]).llm).runCycle()).toMatchObject({ returned: 1, published: 0 });

    expect(await thesisOf(id)).toMatchObject({ status: 'draft', publishedAt: null });
    const trade = await tradeOf(id);
    expect(trade.status).toBe('rejected');
    expect(trade.rejectReason).toContain('price moved');
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
    // The audit is kept: it was done and paid for.
    expect(await auditsOf(id)).toHaveLength(1);
  });

  it('goes back to draft when the market has closed, is about to, or has nobody selling the side', async () => {
    const { user, author } = await person();
    const closed = await submit(author, user.id);
    await db.update(markets).set({ marketState: 'closed' }).where(eq(markets.id, marketId));
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect((await tradeOf(closed)).rejectReason).toContain('no longer open');

    await db.update(markets).set({ marketState: 'open', expiryAt: new Date(NOW.getTime() + 90_000) }).where(eq(markets.id, marketId));
    const late = await submit(author, user.id);
    await pipeline(scripted([]).llm).runCycle();
    expect((await tradeOf(late)).rejectReason).toContain('closes in under 2 minutes');

    await db.update(markets).set({ expiryAt: new Date('2026-11-18T22:00:00Z'), yesAsk: null }).where(eq(markets.id, marketId));
    const noSeller = await submit(author, user.id);
    await pipeline(scripted([]).llm).runCycle();
    expect((await tradeOf(noSeller)).rejectReason).toContain('Nobody is selling YES');
  });

  it('goes back to draft when the paper balance does not cover the stake', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id, { stakeUsd: '1500', limitPrice: '0.60' });
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('paper balance');
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
  });

  it('fills only the size on offer when the live book is thin, and marks the fill partial', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    book = { yesBid: '0.51', yesAsk: '0.55', bidSize: '100.00', askSize: '4.00', at: NOW.getTime() - 1000 };
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await tradeOf(id)).toMatchObject({ status: 'partial', quantity: '4.0000', costUsd: '2.2000' });
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('997.8000');
  });

  it('sends the thesis back when the size on offer is worth less than the $1 minimum stake', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    book = { yesBid: '0.51', yesAsk: '0.55', bidSize: '100.00', askSize: '0.02', at: NOW.getTime() - 1000 };
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('minimum stake');
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
  });

  it('waits, without filling, while the market’s stored quote has stopped updating', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    await db.update(markets).set({ updatedAt: new Date(NOW.getTime() - 5 * 60_000) }).where(eq(markets.id, marketId));
    const run = pipeline(scripted([CLEAN]).llm);
    expect(await run.runCycle()).toMatchObject({ waiting: 1, published: 0 });
    expect(await thesisOf(id)).toMatchObject({ status: 'auditing' });
    // Prices come back: it publishes.
    await db.update(markets).set({ updatedAt: NOW }).where(eq(markets.id, marketId));
    expect(await run.runCycle()).toMatchObject({ published: 1 });
  });

  it('sends the thesis back at once, uncharged, when the day’s model budget is spent', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    const { LlmError } = await import('@thesis/core');
    const run = pipeline(scripted([new LlmError('budget', 'The daily cap is reached.')]).llm);
    expect(await run.runCycle()).toMatchObject({ returned: 1 });
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('daily limit');
  });

  it('does not let one thesis that cannot be published hold up the ones behind it', async () => {
    const stuck = await person('Stuck');
    const fine = await person('Fine');
    const stuckId = await submit(stuck.author, stuck.user.id);
    // Something outside the pipeline published a thesis for the same author and market.
    await db.update(theses).set({ status: 'draft' }).where(eq(theses.id, stuckId));
    const other = await submit(stuck.author, stuck.user.id, { body: 'A different argument entirely.' });
    await db.update(theses).set({ status: 'published', publishedAt: NOW }).where(eq(theses.id, other));
    await db.execute(sql`drop index theses_one_auditing_per_author`);
    await db.execute(sql`drop index theses_one_live_per_author_market`);
    await db.execute(sql`create unique index theses_one_live_per_author_market on theses (author_id, market_id) where status in ('published', 'resolved')`);
    await db.update(theses).set({ status: 'auditing' }).where(eq(theses.id, stuckId));
    const fineId = await submit(fine.author, fine.user.id);

    const run = pipeline(scripted([CLEAN, CLEAN]).llm);
    await run.runCycle();
    expect(await thesisOf(fineId)).toMatchObject({ status: 'published' });
    for (let i = 0; i < 6; i += 1) {
      now = new Date(now.getTime() + 10 * 60_000);
      await run.runCycle();
    }
    // It is given up on, not retried for ever.
    expect(await thesisOf(stuckId)).toMatchObject({ status: 'draft' });
    expect((await getUserById(db, stuck.user.id))!.paperBalanceUsd).toBe('1000.0000');
  });

  it('ignores a live book that is stale and uses the market’s stored quote', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    book = { yesBid: '0.10', yesAsk: '0.12', bidSize: '1.00', askSize: '1.00', at: NOW.getTime() - 60_000 };
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await tradeOf(id)).toMatchObject({ status: 'filled', price: '0.5500' });
  });

  it('does nothing twice: a second cycle changes nothing', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    const run = pipeline(scripted([CLEAN]).llm);
    await run.runCycle();
    const before = [await thesisOf(id), await tradeOf(id), await getUserById(db, user.id)];
    expect(await run.runCycle()).toEqual({ published: 0, blocked: 0, returned: 0, waiting: 0, backfilled: 0 });
    expect([await thesisOf(id), await tradeOf(id), await getUserById(db, user.id)]).toEqual(before);
    expect(await auditsOf(id)).toHaveLength(1);
  });

  it('waits, without charging, while trading is switched off, then publishes once it is back on', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    const run = pipeline(scripted([CLEAN]).llm);
    enabled = false;
    expect(await run.runCycle()).toMatchObject({ waiting: 1, published: 0 });
    expect(await thesisOf(id)).toMatchObject({ status: 'auditing' });
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
    enabled = true;
    // The audit already exists, so the model is not asked again.
    expect(await run.runCycle()).toMatchObject({ published: 1 });
  });

  it('keeps a thesis waiting when the audit fails, retries later, and gives up after five tries', async () => {
    const { user, author } = await person();
    const id = await submit(author, user.id);
    const errors = Array.from({ length: 5 }, () => new Error('HTTP 529'));
    const run = pipeline(scripted(errors).llm);

    expect(await run.runCycle()).toMatchObject({ waiting: 1 });
    expect(await thesisOf(id)).toMatchObject({ status: 'auditing' });
    // Straight away: not retried yet, and the model is not called.
    expect(await run.runCycle()).toMatchObject({ waiting: 1 });
    expect(errors).toHaveLength(4);

    for (let i = 0; i < 4; i += 1) {
      now = new Date(now.getTime() + 10 * 60_000);
      await run.runCycle();
    }
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('audit could not be completed');
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
    expect(await auditsOf(id)).toHaveLength(0);
  });

  it('reuses the audit of an identical thesis instead of paying for it again', async () => {
    const first = await person('Sam');
    const second = await person('Ana');
    const a = await submit(first.author, first.user.id);
    const { llm, requests } = scripted([CLEAN]);
    const run = pipeline(llm);
    await run.runCycle();
    const b = await submit(second.author, second.user.id);
    await run.runCycle();
    expect(requests).toHaveLength(1);
    expect(await thesisOf(b)).toMatchObject({ status: 'published' });
    expect(await auditsOf(a)).toHaveLength(1);
    expect(await auditsOf(b)).toMatchObject([{ verdict: 'pass', model: 'test-model' }]);
  });

  it('runs the phrase screen only when no model is configured, and says so on the audit', async () => {
    const { user, author } = await person();
    const ok = await submit(author, user.id);
    await pipeline(null).runCycle();
    expect(await thesisOf(ok)).toMatchObject({ status: 'published' });
    expect(await auditsOf(ok)).toMatchObject([{ verdict: 'pass', model: 'keyword-screen', claims: [] }]);
  });
});

describe('an agent’s thesis', () => {
  it('is filled from the agent’s bankroll under its limits, and every outcome is logged', async () => {
    const author = await agent('news');
    const id = await submit(author, null, { stakeUsd: '10', limitPrice: '0.60' });
    await pipeline(scripted([CLEAN]).llm).runCycle();

    expect(await thesisOf(id)).toMatchObject({ status: 'published' });
    expect(await tradeOf(id)).toMatchObject({ status: 'filled', userId: null, authorId: author.id, costUsd: '9.9990' });
    const [state] = await db.select().from(agentState);
    expect(state).toMatchObject({ agentKey: 'news', day: '2026-11-18', tradeCount: 1, openExposureUsd: '9.9990', halted: false });
    const runs = await db.select().from(agentRuns);
    expect(runs).toMatchObject([{ agentKey: 'news', decision: 'trade', marketId }]);
    expect(runs[0]!.reason).toContain('Simulated fill');
  });

  it('is refused when the spread is too wide, and the skip is logged with the reason', async () => {
    const author = await agent('news');
    await db.update(markets).set({ yesBid: '0.45', yesAsk: '0.55' }).where(eq(markets.id, marketId));
    const id = await submit(author, null, { stakeUsd: '10' });
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('Spread');
    expect(await db.select().from(agentRuns)).toMatchObject([{ decision: 'skip' }]);
    expect((await db.select().from(agentState))[0]).toMatchObject({ tradeCount: 0 });
  });

  it('is refused once the agent has lost $50 today, and the agent is halted', async () => {
    const author = await agent('news');
    await db.insert(agentState).values({ agentKey: 'news', day: '2026-11-18', realizedPnlUsd: '-50' });
    const id = await submit(author, null, { stakeUsd: '10' });
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect(await thesisOf(id)).toMatchObject({ status: 'draft' });
    expect((await tradeOf(id)).rejectReason).toContain('Daily loss stop');
    expect((await db.select().from(agentState))[0]).toMatchObject({ halted: true, haltReason: 'daily loss stop' });
  });

  it('is refused when it would take open exposure past $150', async () => {
    const author = await agent('news');
    // Fifteen open $10 positions on other contracts.
    for (let i = 0; i < 15; i += 1) {
      const other = await upsertMarket(db, market({ instrumentSymbol: `GEMI-OPEN-${i}` }));
      await db.insert(trades).values({
        authorId: author.id,
        marketId: other.id,
        side: 'yes',
        quantity: '20',
        price: '0.5',
        costUsd: '10',
        mode: 'paper',
        status: 'filled',
        idempotencyKey: `open-${i}`,
      });
    }
    const id = await submit(author, null, { stakeUsd: '10' });
    await pipeline(scripted([CLEAN]).llm).runCycle();
    expect((await tradeOf(id)).rejectReason).toContain('open exposure');
  });

  it('is blocked like anyone else’s, and the block is logged', async () => {
    const author = await agent('news');
    const id = await submit(author, null, { body: 'I work there and the numbers are bad.' });
    await pipeline(scripted([]).llm).runCycle();
    expect(await thesisOf(id)).toMatchObject({ status: 'blocked' });
    const runs = await db.select().from(agentRuns);
    expect(runs).toMatchObject([{ decision: 'skip' }]);
    expect(runs[0]!.reason).toContain('Blocked by the audit');
  });
});

describe('theses published without an audit', () => {
  it('are audited afterwards, once nothing is waiting, without changing the thesis or its trade', async () => {
    const author = await agent('momentum');
    const id = await submit(author, null);
    // Another job published this one directly, with no audit.
    await db.update(theses).set({ status: 'published', publishedAt: NOW, entryPrice: '0.55' }).where(eq(theses.id, id));
    await db.update(trades).set({ status: 'filled' }).where(eq(trades.thesisId, id));
    const before = [await thesisOf(id), await tradeOf(id)];

    const run = pipeline(scripted([CLEAN]).llm);
    expect(await run.runCycle()).toMatchObject({ backfilled: 1, published: 0 });
    expect(await auditsOf(id)).toMatchObject([{ verdict: 'pass' }]);
    expect([await thesisOf(id), await tradeOf(id)]).toEqual(before);
    expect(await run.runCycle()).toMatchObject({ backfilled: 0 });
  });

  it('record a late finding as a flag: a thesis that is already public is never marked blocked', async () => {
    const author = await agent('momentum');
    const id = await submit(author, null, { body: 'I work there and the numbers are bad.' });
    await db.update(theses).set({ status: 'published', publishedAt: NOW, entryPrice: '0.55' }).where(eq(theses.id, id));
    await db.update(trades).set({ status: 'filled' }).where(eq(trades.thesisId, id));
    await pipeline(scripted([]).llm).runCycle();
    const [audit] = await auditsOf(id);
    expect(audit).toMatchObject({ verdict: 'flagged', insideInfo: true });
    expect(audit!.blockReason).toContain('inside or non-public knowledge');
    expect(await thesisOf(id)).toMatchObject({ status: 'published' });
  });
});
