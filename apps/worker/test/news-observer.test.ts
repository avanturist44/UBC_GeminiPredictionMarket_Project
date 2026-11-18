import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentRuns, agentState, authors, markets, theses, trades, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import type { GeminiEvent } from '@thesis/core';
import { createNewsObserver } from '../src/news-observer';
import { NEWS_INTERVAL_MS, type NewsResearchProvider, type NewsResearchRequest, type NewsResearchResult } from '../src/news';

let db: Db; let close: () => Promise<void>; let now: number; let symbol: string;
let event: GeminiEvent;
beforeEach(async () => {
  ({ db, close } = await createTestDb()); now = Date.parse('2026-11-18T12:00:00Z');
  symbol = 'GEMI-BTC2611182200-HI65000';
  await db.insert(markets).values({ instrumentSymbol: symbol, eventTicker: 'BTC2611182200', contractTicker: 'HI65000',
    title: 'BTC above 65,000', category: 'Crypto', tracked: true, status: 'active', marketState: 'open', expiryAt: new Date(now + 8 * 3600_000) });
  event = { ticker: 'BTC2611182200', title: 'BTC above 65,000', status: 'active', description: 'Official event description',
    contracts: [{ instrumentSymbol: symbol, ticker: 'HI65000', label: 'Above 65,000', marketState: 'open', status: 'active',
      expiryDate: new Date(now + 8 * 3600_000).toISOString(), description: 'Resolves YES if the official index reaches the specified strike at expiry.' }] };
});
afterEach(async () => { await close(); });

function result(): NewsResearchResult {
  return { searchedAtMs: now, provider: 'fixture', model: 'fixture-model',
    sources: [{ url: 'https://a.example.org/news', title: 'Public report' }, { url: 'https://b.example.com/data', title: 'Public data' }],
    forecast: { probability_yes: .75, confidence: 'high', headline: 'Fixture thesis', body: 'Fixture reasoning, not live research.', no_trade_reason: null,
      evidence: [{ claim: 'Report', url: 'https://a.example.org/news' }, { claim: 'Data', url: 'https://b.example.com/data' }] } };
}
function setup(provider?: NewsResearchProvider, signal?: AbortSignal) {
  const client = { getEvent: vi.fn(async (_ticker: string) => event) };
  const observer = createNewsObserver(db, client, { enabled: () => true, now: () => now, provider, signal });
  observer.handleTicker({ symbolKey: symbol.toLowerCase(), bid: '.48', ask: '.5', bidSize: '9', askSize: '7', last: null }, now);
  return { observer, client };
}

it('logs missing configuration and persists the 15-minute cadence across observer restarts', async () => {
  const { observer } = setup(); expect(await observer.run()).toBe(1); expect(await observer.run()).toBe(0);
  expect(await setup().observer.run()).toBe(0);
  expect((await db.select().from(agentRuns))[0]?.reason).toBe('news research provider not configured');
  expect(await db.select().from(trades)).toHaveLength(0);
});

it('logs a grounded hypothetical entry with official rules and fresh quotes, without publishing or trading', async () => {
  const research = vi.fn(async (_request: NewsResearchRequest, _signal: AbortSignal) => result()); const { observer, client } = setup({ research });
  await Promise.all([observer.run(), observer.run()]);
  expect(research).toHaveBeenCalledTimes(1); expect(client.getEvent).toHaveBeenCalledTimes(2);
  expect(research.mock.calls[0]?.[0]).toMatchObject({ eventTicker: event.ticker, instrumentSymbol: symbol,
    rules: expect.stringContaining('Resolves YES'), asOf: new Date(now).toISOString() });
  const [run] = await db.select().from(agentRuns);
  expect(run).toMatchObject({ decision: 'skip', reason: 'log only: hypothetical news entry',
    signal: { mode: 'log-only', decision: 'candidate', side: 'yes', entryPrice: .5,
      context: { contractLabel: 'Above 65,000', rules: expect.stringContaining('Resolves YES') } } });
  expect(await db.select().from(trades)).toHaveLength(0); expect(await db.select().from(theses)).toHaveLength(0);
});

it('rechecks eligibility and quote changes after research', async () => {
  const { observer } = setup({ research: async () => { event.contracts[0]!.marketState = 'closed'; return result(); } });
  await observer.run();
  expect((await db.select().from(agentRuns))[0]?.reason).toBe('market became ineligible during research');
});

it('does not call a provider when the official contract has no rules', async () => {
  event.contracts[0]!.description = null;
  const research = vi.fn(async () => result()); await setup({ research }).observer.run();
  expect(research).not.toHaveBeenCalled();
  expect((await db.select().from(agentRuns))[0]?.reason).toBe('official market closed or missing contract rules');
});

it('enforces a durable rolling hourly budget before requesting research', async () => {
  for (let n = 16; n < 20; n++) await db.insert(agentRuns).values({ agentKey: 'news', decision: 'skip',
    createdAt: new Date(now - n * 60_000), signal: { researchRequested: true } });
  const research = vi.fn(async () => result()); await setup({ research }).observer.run();
  expect(research).not.toHaveBeenCalled();
  expect((await db.select().from(agentRuns)).some((r) => r.reason === 'hourly research call limit')).toBe(true);
});

it('redacts provider error messages and halts after five consecutive research failures', async () => {
  const { observer } = setup({ research: async () => { throw new Error('secret-api-key-do-not-log'); } });
  for (let n = 0; n < 5; n++) { await observer.run(); now += NEWS_INTERVAL_MS; }
  expect((await db.select().from(agentState))[0]).toMatchObject({ agentKey: 'news', halted: true, haltReason: 'consecutive errors' });
  const runs = await db.select().from(agentRuns);
  expect(JSON.stringify(runs)).not.toContain('secret-api-key-do-not-log');
  await observer.run();
  expect((await db.select().from(agentRuns)).some((r) => r.reason === 'news agent halted')).toBe(true);
});

it('cancels outstanding research without creating a trade or recording a provider failure', async () => {
  const abort = new AbortController();
  const { observer } = setup({ research: async () => {
    queueMicrotask(() => abort.abort()); return new Promise<NewsResearchResult>(() => {});
  } }, abort.signal);
  await observer.run();
  expect((await db.select().from(agentRuns))[0]).toMatchObject({ reason: 'news research cancelled', error: null });
  expect(await db.select().from(trades)).toHaveLength(0);
});

it('rotates to the least recently researched eligible market', async () => {
  await db.insert(markets).values({ instrumentSymbol: 'GEMI-BRENT2611182200-HI70', eventTicker: 'BRENT2611182200', contractTicker: 'HI70',
    title: 'Oil', category: 'Commodities', tracked: true, status: 'active', marketState: 'open', expiryAt: new Date(now + 9 * 3600_000) });
  const { observer, client } = setup({ research: async () => result() });
  await observer.run(); now += NEWS_INTERVAL_MS; await observer.run();
  expect(client.getEvent.mock.calls.some(([ticker]) => ticker === 'BRENT2611182200')).toBe(true);
});

it('disables scheduling without writing an author or decision log', async () => {
  const observer = createNewsObserver(db, { getEvent: async () => event }, { enabled: () => false });
  expect(await observer.run()).toBe(0); expect(await db.select().from(agentRuns)).toHaveLength(0);
  expect(await db.select().from(authors)).toHaveLength(0);
});
