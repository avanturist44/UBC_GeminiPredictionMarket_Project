import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, agentState, authors, eq, markets, theses, trades, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import type { GeminiEvent } from '@thesis/core';
import { createMomentumObserver } from '../src/momentum-observer';
import { createPaperAdapter, decimal, paperFill, recordMomentumError, units } from '../src/paper';
import type { MomentumInput } from '../src/momentum';

let db: Db;
let close: () => Promise<void>;
let now: number;
let outcome: 'yes' | 'no' | null;
let invalid: boolean;
let enabled: boolean;
const client = { async getEvent(ticker: string): Promise<GeminiEvent> {
  return { ticker, title: 'BTC', status: invalid ? 'invalid' : 'settled', contracts: [{
    ticker: 'UP', instrumentSymbol: `GEMI-${ticker}-UP`, resolutionSide: outcome,
  }] };
} };
const adapter = () => createPaperAdapter(db, client, { now: () => now, enabled: () => enabled });
async function market(n = 0) {
  const ticker = `BTC15M261118${String(1000 + n)}`;
  const [row] = await db.insert(markets).values({ instrumentSymbol: `GEMI-${ticker}-UP`,
    eventTicker: ticker, contractTicker: 'UP', title: 'BTC 15 minute', tracked: true,
    status: 'active', marketState: 'open', strike: '100', expiryAt: new Date(now + 5 * 60_000),
    sourceDetails: { agency: 'lukka', index: 'LS-LRRR-XBTUSD' },
    quantityIncrement: '0.01', quantityMinimum: '0.01' }).returning();
  return row!;
}
function input(price = 102): MomentumInput {
  return { nowMs: now, expiryMs: now + 300_000, marketState: 'open', strike: 100,
    indexPrice: price, indexObservedAtMs: now, volatilityPerMinute: 0.001,
    quote: { bid: 0.48, ask: 0.5, bidSize: 100, askSize: 100, observedAtMs: now } };
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  now = Date.parse('2026-11-18T10:05:00Z'); outcome = 'yes'; invalid = false; enabled = true;
});
afterEach(async () => { await close(); });

describe('BTC paper execution and official settlement', () => {
  it('logs three paper fills, buys NO at 1-bid, and retries without duplicate positions', async () => {
    const bot = adapter();
    for (let n = 0; n < 3; n++) {
      const row = await market(n);
      await bot.execute(row.id, () => input(n === 1 ? 98 : 102));
      await bot.execute(row.id, () => input(98));
    }
    const fills = await db.select().from(trades);
    expect(fills).toHaveLength(3);
    const published = await db.select().from(theses);
    expect(published).toHaveLength(3);
    expect(published.every((t) => t.status === 'published' && t.body.includes('Simulated trade'))).toBe(true);
    expect(fills.every((f) => published.some((t) => t.id === f.thesisId))).toBe(true);
    expect(fills.map((f) => f.mode)).toEqual(['paper', 'paper', 'paper']);
    expect(fills[1]).toMatchObject({ side: 'no', price: '0.5200', quantity: '19.2300', costUsd: '9.9996' });
    expect((await db.select().from(agentRuns)).filter((r) => r.decision === 'trade')).toHaveLength(3);
    expect((await db.select().from(agentState))[0]?.tradeCount).toBe(3);
    now += 360_000;
    expect(await bot.settle()).toBe(3);
    expect(await bot.settle()).toBe(0);
    const settled = await db.select().from(trades);
    expect(settled.map((p) => p.status)).toEqual(['settled', 'settled', 'settled']);
    expect(settled.map((p) => p.payoutUsd)).toEqual(['20.0000', '0.0000', '20.0000']);
    expect((await db.select().from(theses)).map((t) => t.outcome)).toEqual(['right', 'wrong', 'right']);
    expect((await db.select().from(agentState))[0]).toMatchObject({ openExposureUsd: '0.0000', realizedPnlUsd: '10.0004' });
  });

  it('halts at exactly $50 realized daily loss and resumes only on the next UTC day', async () => {
    const bot = adapter();
    const row = await market();
    await bot.execute(row.id, input);
    await db.update(agentState).set({ realizedPnlUsd: '-40' });
    now += 360_000; outcome = 'no';
    expect(await bot.settle()).toBe(1);
    expect((await db.select().from(agentState))[0]).toMatchObject({ halted: true, haltReason: 'daily loss stop', realizedPnlUsd: '-50.0000' });
    const second = await market(1);
    await bot.execute(second.id, input);
    expect(await db.select().from(trades)).toHaveLength(1);
    now = Date.parse('2026-11-19T00:05:00Z');
    const third = await market(2);
    await bot.execute(third.id, input);
    expect(await db.select().from(trades)).toHaveLength(2);
  });

  it('waits for an official result, refunds invalid contracts, and releases exposure', async () => {
    const bot = adapter(); const row = await market();
    await bot.execute(row.id, input);
    now += 360_000; outcome = null;
    expect(await bot.settle()).toBe(0);
    invalid = true;
    expect(await bot.settle()).toBe(1);
    expect((await db.select().from(trades))[0]?.payoutUsd).toBe('10.0000');
    expect((await db.select().from(agentState))[0]?.realizedPnlUsd).toBe('0.0000');
  });

  it('pays a winning NO position at one dollar per contract on the settlement UTC day', async () => {
    const row = await market();
    await adapter().execute(row.id, () => input(98));
    now = Date.parse('2026-11-19T00:05:00Z'); outcome = 'no';
    expect(await adapter().settle()).toBe(1);
    expect((await db.select().from(trades))[0]?.payoutUsd).toBe('19.2300');
    const state = (await db.select().from(agentState)).find((s) => s.day === '2026-11-19');
    expect(state).toMatchObject({ realizedPnlUsd: '9.2304', openExposureUsd: '0.0000', tradeCount: 0 });
  });

  it('rolls back the thesis, accounting, and decision log if the fill insert fails', async () => {
    const row = await market();
    const [author] = await db.insert(authors).values({ kind: 'agent', agentKey: 'momentum', displayName: 'BTC' }).returning();
    await db.insert(trades).values({ authorId: author!.id, marketId: row.id, side: 'yes', quantity: '1', price: '0.5',
      costUsd: '0.5', mode: 'paper', status: 'rejected', idempotencyKey: `paper:momentum:${row.id}` });
    await expect(adapter().execute(row.id, input)).rejects.toThrow();
    expect(await db.select().from(theses)).toHaveLength(0);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
    expect(await db.select().from(agentState)).toHaveLength(0);
  });

  it('rejects stale inputs, a kill switch, too-small size, and prices outside the band', async () => {
    const bot = adapter(); const row = await market();
    const stale = input(); stale.indexObservedAtMs -= 10_001;
    await bot.execute(row.id, () => stale);
    enabled = false; await bot.execute(row.id, input);
    enabled = true;
    const tiny = input(); tiny.quote!.askSize = 0.001;
    await bot.execute(row.id, () => tiny);
    const band = input(); band.quote!.bid = 0.02; band.quote!.ask = 0.04;
    await bot.execute(row.id, () => band);
    expect(await db.select().from(trades)).toHaveLength(0);
    expect(await db.select().from(agentRuns)).toHaveLength(4);
  });

  it('checks freshness after waiting for the transaction and respects available YES size', async () => {
    const row = await market();
    const stale = input(); now += 10_001;
    await adapter().execute(row.id, () => stale);
    const small = input(); small.quote!.askSize = 3;
    await adapter().execute(row.id, () => small);
    expect((await db.select().from(trades))[0]).toMatchObject({ quantity: '3.0000', costUsd: '1.5000' });
  });

  it('rolls back a fill when the executable book changes while writes are in flight', async () => {
    const row = await market(); let reads = 0;
    await adapter().execute(row.id, () => {
      const value = input();
      if (++reads > 1) value.quote!.askSize = 1;
      return value;
    });
    expect(await db.select().from(trades)).toHaveLength(0);
    expect(await db.select().from(theses)).toHaveLength(0);
    expect((await db.select().from(agentRuns))[0]?.decision).toBe('skip');
  });

  it('carries open exposure across UTC midnight and caps remaining room', async () => {
    const row = await market(); await adapter().execute(row.id, input);
    const [author] = await db.select().from(authors);
    await db.insert(trades).values({ authorId: author!.id, marketId: row.id, side: 'yes', quantity: '278',
      price: '0.5', costUsd: '139', mode: 'paper', status: 'filled', idempotencyKey: 'other-position' });
    now = Date.parse('2026-11-19T00:05:00Z');
    const second = await market(1); await adapter().execute(second.id, input);
    const fill = (await db.select().from(trades).where(eq(trades.marketId, second.id)))[0];
    expect(fill?.costUsd).toBe('1.0000');
    const third = await market(2); await adapter().execute(third.id, input);
    expect(await db.select().from(trades)).toHaveLength(3);
  });

  it('enforces the daily trade count and persistent five-error halt', async () => {
    const row = await market(); await adapter().execute(row.id, input);
    await db.update(agentState).set({ tradeCount: 30 });
    const second = await market(1); await adapter().execute(second.id, input);
    expect(await db.select().from(trades)).toHaveLength(1);
    for (let n = 0; n < 5; n++) { now += 1000; await recordMomentumError(db, new Error('test failure'), now); }
    await db.update(agentState).set({ realizedPnlUsd: '-50' });
    await adapter().execute(second.id, input);
    expect((await db.select().from(agentState))[0]?.haltReason).toBe('consecutive errors');
    now = Date.parse('2026-11-19T00:05:00Z');
    const third = await market(2); await adapter().execute(third.id, input);
    expect(await db.select().from(trades)).toHaveLength(1);
  });
});

describe('observer warmup and hypothetical signals', () => {
  it('records a skip with stream health when all tracked BTC contracts have expired', async () => {
    await market(); now += 360_000;
    const observer = createMomentumObserver(db, { now: () => now });
    expect(await observer.run()).toBe(1);
    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ marketId: null, decision: 'skip',
      reason: 'no unexpired tracked BTC 15-minute contracts',
      signal: { mode: 'log-only', health: { indexAgeMs: null, volatilityReturnCount: 0, freshBooks: 0 } } });
  });

  it('requires 31 completed closes and exposes missing minutes without counting the current minute', async () => {
    await market();
    const observer = createMomentumObserver(db, { now: () => now });
    for (let n = 30; n >= 0; n--) {
      const at = now - n * 60_000;
      observer.handleOther(JSON.stringify({ e: 'thirdPartyPrice', s: 'btcusd', I: 'LRRR_XBT',
        p: String(100 + (n % 2) * 0.1), E: at / 1000 }), at);
    }
    expect(observer.status()).toMatchObject({ completedCloses: 30, volatilityReturnCount: 29, volatilityPerMinute: null });
    await observer.run();
    expect((await db.select().from(agentRuns))[0]?.reason).toBe('warming up volatility (29/30 returns)');
    now += 60_000;
    expect(observer.status()).toMatchObject({ completedCloses: 31, volatilityReturnCount: 30 });
    expect(observer.status().volatilityPerMinute).toBeGreaterThan(0);
    now += 60_000;
    expect(observer.status()).toMatchObject({ completedCloses: 0, volatilityReturnCount: 0, volatilityPerMinute: null });
  });

  it('stores warmup, hypothetical YES/NO, and stale skips in agent_runs without fills', async () => {
    const row = await market();
    const observer = createMomentumObserver(db, { now: () => now });
    await observer.run();
    for (let n = 31; n >= 1; n--) {
      const at = now - n * 60_000;
      observer.handleOther(JSON.stringify({ e: 'thirdPartyPrice', s: 'btcusd', I: 'LRRR_XBT',
        p: String(100 + (n % 2) * 0.1), E: at / 1000 }), at);
    }
    const ticker = { symbolKey: row.instrumentSymbol.toLowerCase(), bid: '0.48', ask: '0.5',
      bidSize: '100', askSize: '100', last: null };
    observer.handleTicker(ticker, now);
    for (const price of [102, 98]) {
      observer.handleOther(JSON.stringify({ e: 'thirdPartyPrice', s: 'btcusd', I: 'LRRR_XBT', p: String(price), E: now / 1000 }), now);
      await observer.run();
    }
    now += 10_001; await observer.run();
    const logs = await db.select().from(agentRuns);
    expect(logs).toHaveLength(4);
    expect(logs[1]?.signal).toMatchObject({ mode: 'log-only', decision: 'trade', side: 'yes' });
    expect(logs[2]?.signal).toMatchObject({ mode: 'log-only', decision: 'trade', side: 'no' });
    expect(logs[3]?.reason).toBe('stale index price');
    expect(await db.select().from(trades)).toHaveLength(0);
  });
});

it('uses exact money and quantizes down to executable increments', () => {
  expect(decimal(units('-12.3401'))).toBe('-12.3401');
  expect(paperFill(0.61, 100, '0.01', '0.01', 100_000n)).toMatchObject({ quantity: '16.3900', costUsd: '9.9979' });
  expect(paperFill(0.96, 100, '0.01', '0.01', 100_000n)).toBeNull();
});
