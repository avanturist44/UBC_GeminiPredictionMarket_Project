import { createLlm, type LlmCompletion, type LlmRequest } from '@thesis/core';
import {
  agentRuns,
  agentState,
  audits,
  eq,
  insertPricePoint,
  theses,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFadeCycle, runNewsCycle } from '../src/agents';
import { createThesisPipeline } from '../src/thesis-pipeline';

const NOW = new Date('2026-11-18T05:00:00Z');

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BRENT2611182200-HI90',
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

const estimate = (overrides: object = {}) =>
  JSON.stringify({
    probability_yes: 0.72,
    confidence: 'medium',
    headline: 'Three weeks of draws point to a close above $90',
    body: 'US crude stocks fell for a third week and the prompt spread tightened.',
    evidence: [
      { claim: 'EIA weekly report shows a draw', url: 'https://www.eia.gov/petroleum/supply/weekly/' },
      { claim: 'Reuters: prompt spread at a six-week high', url: 'https://www.reuters.com/markets/commodities/x' },
    ],
    no_trade_reason: null,
    ...overrides,
  });
const CLEAN = JSON.stringify({ inside_info: false, inside_info_quote: null, prohibited: 'none', claims: [] });

let db: Db;
let close: () => Promise<void>;
let enabled: boolean;
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  enabled = true;
});
afterEach(() => close());

const deps = (llm: ReturnType<typeof scripted>['llm'], now = NOW) => ({
  db,
  llm,
  tradingEnabled: () => enabled,
  logger,
  now: () => now,
});

describe('runNewsCycle', () => {
  it('estimates, decides in code, and sends its thesis to the auditor with its intended position', async () => {
    const { id: marketId } = await upsertMarket(db, market());
    const { llm, requests } = scripted([estimate()]);
    const cycle = await runNewsCycle(deps(llm));
    expect(cycle).toMatchObject({ market: 'GEMI-BRENT2611182200-HI90', decision: 'trade' });

    const [thesis] = await db.select().from(theses);
    expect(thesis).toMatchObject({
      status: 'auditing',
      marketId,
      side: 'yes',
      probabilityYes: '0.7200',
      headline: 'Three weeks of draws point to a close above $90',
    });
    expect(thesis!.evidence).toHaveLength(2);
    // $10 stake; it will pay at most 62 cents, which keeps a 10-point edge.
    const [trade] = await db.select().from(trades);
    expect(trade).toMatchObject({ status: 'pending', userId: null, price: '0.6200', costUsd: '10.0000', isAuthorPosition: true });

    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ agentKey: 'news', decision: 'trade', marketId });
    expect(run!.signal).toMatchObject({ probabilityYes: 0.72, side: 'yes', limitPrice: '0.62', thesisId: thesis!.id });

    // The model searched, and saw the market as data.
    expect(requests[0]!.useSearch).toBe(true);
    expect(requests[0]!.user).toContain('<data name="market">');
  });

  it('then the pipeline audits, fills under the agent’s limits and publishes', async () => {
    await upsertMarket(db, market());
    await runNewsCycle(deps(scripted([estimate()]).llm));
    const pipeline = createThesisPipeline({ db, llm: scripted([CLEAN]).llm, tradingEnabled: () => true, logger, now: () => NOW });
    expect(await pipeline.runCycle()).toMatchObject({ published: 1 });
    expect((await db.select().from(theses))[0]).toMatchObject({ status: 'published', entryPrice: '0.5500' });
    expect((await db.select().from(trades))[0]).toMatchObject({ status: 'filled', price: '0.5500' });
    expect(await db.select().from(audits)).toHaveLength(1);
    expect((await db.select().from(agentState))[0]).toMatchObject({ agentKey: 'news', tradeCount: 1 });
  });

  it('logs a skip, with the reason, when its estimate is close to the price', async () => {
    await upsertMarket(db, market());
    const cycle = await runNewsCycle(deps(scripted([estimate({ probability_yes: 0.58 })]).llm));
    expect(cycle).toMatchObject({ decision: 'skip' });
    expect(await db.select().from(theses)).toHaveLength(0);
    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ decision: 'skip', error: null });
    expect(run!.reason).toContain('within 10 points');
  });

  it('does not look at short crypto windows, one-sided books, or markets about to close', async () => {
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-BTC15M2611180515-UP', eventTicker: 'BTC15M2611180515', expiryAt: new Date('2026-11-18T08:00:00Z') }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-ONE-SIDED', yesBid: null }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-CLOSING', expiryAt: new Date(NOW.getTime() + 20 * 60_000) }));
    const { llm, requests } = scripted([]);
    expect(await runNewsCycle(deps(llm))).toMatchObject({ market: null, decision: 'skip' });
    expect(requests).toHaveLength(0);
    expect((await db.select().from(agentRuns))[0]!.reason).toContain('No market is due');
  });

  it('looks at a different market each cycle and leaves one it has a thesis on alone', async () => {
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-A' }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-B' }));
    const { llm } = scripted([estimate(), estimate({ probability_yes: 0.58 })]);
    const first = await runNewsCycle(deps(llm));
    // The auditor has dealt with the first thesis by the time the next cycle comes round.
    await db.update(theses).set({ status: 'published' });
    const second = await runNewsCycle(deps(llm, new Date(NOW.getTime() + 15 * 60_000)));
    expect([first.market, second.market].sort()).toEqual(['GEMI-A', 'GEMI-B']);
    // Both were looked at within six hours: nothing is due.
    expect(await runNewsCycle(deps(scripted([]).llm, new Date(NOW.getTime() + 30 * 60_000)))).toMatchObject({ market: null });
  });

  it('waits, and calls no model, while an earlier thesis of its own is still with the auditor', async () => {
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-A' }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-B' }));
    await runNewsCycle(deps(scripted([estimate()]).llm));
    const second = scripted([]);
    const cycle = await runNewsCycle(deps(second.llm, new Date(NOW.getTime() + 15 * 60_000)));
    expect(cycle).toMatchObject({ market: null, decision: 'skip' });
    expect(cycle.reason).toContain('auditor');
    expect(second.requests).toHaveLength(0);
  });

  it('records a failed model call and carries on next cycle', async () => {
    await upsertMarket(db, market());
    const cycle = await runNewsCycle(deps(scripted([new Error('HTTP 529')]).llm));
    expect(cycle).toMatchObject({ decision: 'skip', reason: 'The model call failed.' });
    expect((await db.select().from(agentRuns))[0]!.error).toContain('529');
  });

  it('does nothing, and calls no model, when trading is off or the agent is halted', async () => {
    await upsertMarket(db, market());
    enabled = false;
    const off = scripted([]);
    expect(await runNewsCycle(deps(off.llm))).toMatchObject({ decision: 'skip', reason: 'Trading is switched off.' });
    enabled = true;
    await db.insert(agentState).values({ agentKey: 'news', day: '2026-11-18', halted: true, haltReason: 'daily loss stop' });
    const halted = scripted([]);
    expect((await runNewsCycle(deps(halted.llm))).reason).toContain('daily loss stop');
    expect(off.requests.length + halted.requests.length).toBe(0);
  });
});

describe('runFadeCycle', () => {
  async function movedMarket() {
    const { id } = await upsertMarket(db, market({ yesBid: '0.60', yesAsk: '0.64' }));
    const point = (minutesAgo: number, bid: string, ask: string) =>
      insertPricePoint(db, { marketId: id, ts: new Date(NOW.getTime() - minutesAgo * 60_000), yesBid: bid, yesAsk: ask, lastPrice: null, source: 'ws' });
    await point(29, '0.40', '0.44');
    await point(15, '0.50', '0.54');
    await point(0.5, '0.60', '0.64');
    return id;
  }

  it('bets against an unexplained move, with the numbers in its thesis written by code', async () => {
    const marketId = await movedMarket();
    const { llm } = scripted([
      JSON.stringify({
        explained: false,
        explanation: null,
        sources: [{ claim: 'Reuters energy page shows no new headlines', url: 'https://www.reuters.com/business/energy/' }],
      }),
    ]);
    expect(await runFadeCycle(deps(llm))).toMatchObject({ decision: 'trade' });

    const [thesis] = await db.select().from(theses).where(eq(theses.marketId, marketId));
    // YES ran from 42 to 62. Half back puts YES at 52, so the agent buys NO.
    expect(thesis).toMatchObject({ status: 'auditing', side: 'no', probabilityYes: '0.5200' });
    expect(thesis!.headline).toBe('Fading a 20-point rise with no news behind it');
    expect(thesis!.body).toContain('YES rose from 42¢ to 62¢');
    expect(thesis!.body).toContain('puts YES at 52%');
    expect(thesis!.evidence[0]!.url).toBe('https://www.gemini.com/predictions/BRENT2611182200');
    expect(thesis!.evidence).toHaveLength(2);
    expect((await db.select().from(agentRuns))[0]).toMatchObject({ agentKey: 'fade', decision: 'trade' });
  });

  it('leaves an explained move alone', async () => {
    await movedMarket();
    const { llm } = scripted([JSON.stringify({ explained: true, explanation: 'OPEC announced a surprise cut.', sources: [] })]);
    const cycle = await runFadeCycle(deps(llm));
    expect(cycle).toMatchObject({ decision: 'skip' });
    expect(cycle.reason).toContain('OPEC announced');
    expect(await db.select().from(theses)).toHaveLength(0);
  });

  it('calls no model when nothing moved', async () => {
    await upsertMarket(db, market());
    const { llm, requests } = scripted([]);
    expect((await runFadeCycle(deps(llm))).reason).toContain('No market moved');
    expect(requests).toHaveLength(0);
  });
});
