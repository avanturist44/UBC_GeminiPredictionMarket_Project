import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { audits, authors, eq, markets, theses, thesisJobs, trades, users, type Db } from '@thesis/db';
import { createTestDb } from '../../db/src/testing';
import { createGuest, submitThesis, ThesisSubmissionSchema } from '../src/publication';
import { processThesisJob } from '../src/queue';
import { publishHuman, settleHumans, type ExecutableQuote } from '../src/human-paper';
import { getThesisView, listThesisFeed } from '../src/feed';
import { flagLegacyTheses } from '../src/legacy';
import type { AuditResult } from '../src/audit';

let db: Db, close: () => Promise<void>;
const now = Date.parse('2026-11-18T12:00:00Z');
const checked: AuditResult = { verdict: 'flagged', insideInfo: false, model: 'fixture-auditor',
  claims: [{ text: 'A false fixture claim', status: 'contradicted', source_url: 'https://example.com/facts', note: 'Fixture-only evidence.' }] };
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(() => close());
async function setup() {
  const user = await createGuest(db, 'Fixture guest');
  const symbol = `GEMI-TEST-${randomUUID()}`;
  const [market] = await db.insert(markets).values({ instrumentSymbol: symbol, eventTicker: symbol,
    contractTicker: 'UP', title: 'Fixture market', status: 'active', marketState: 'open', tracked: true,
    expiryAt: new Date(now + 600_000), yesBid: '0.48', yesAsk: '0.50', quantityIncrement: '0.01', quantityMinimum: '0.01' }).returning();
  const input = { idempotencyKey: randomUUID(), symbol, headline: 'A public fixture forecast',
    body: 'This is a fixture prediction based on public evidence, not a guarantee.',
    side: 'yes' as const, probabilityYes: 0.7, stakeUsd: '5', evidence: [{ claim: 'Fixture evidence', url: 'https://example.com/facts' }] };
  const quote: ExecutableQuote = { symbol, bid: 0.48, ask: 0.5, bidSize: 100, askSize: 100,
    observedAtMs: now, marketObservedAtMs: now, status: 'active', marketState: 'open', expiryMs: now + 600_000,
    quantityIncrement: '0.01', quantityMinimum: '0.01' };
  return { user, market: market!, input, quote };
}
async function ready(fixture: Awaited<ReturnType<typeof setup>>) {
  await submitThesis(db, fixture.user.id, fixture.input, now);
  await db.update(thesisJobs).set({ status: 'running', startedAt: new Date(now) }).where(eq(thesisJobs.thesisId, fixture.input.idempotencyKey));
  await db.insert(audits).values({ thesisId: fixture.input.idempotencyKey, ...checked });
}
describe('audited paper publication', () => {
  it('strictly validates stakes, format, probability, sources and unknown fields', () => {
    expect(ThesisSubmissionSchema.safeParse({}).success).toBe(false);
    for (const stakeUsd of ['0', '0.99', '10.01', '999', 'NaN', '-1']) expect(ThesisSubmissionSchema.shape.stakeUsd.safeParse(stakeUsd).success).toBe(false);
  });
  it('blocks insider submissions privately, without inserting a trade', async () => {
    const f = await setup();
    f.input.body = 'I work at the company and know the result from inside information.';
    const result = await submitThesis(db, f.user.id, f.input, now);
    expect(result.status).toBe('blocked');
    expect(await getThesisView(db, result.id)).toBeNull();
    expect(await getThesisView(db, result.id, randomUUID())).toBeNull();
    expect((await getThesisView(db, result.id, f.user.id))?.audit?.verdict).toBe('blocked');
    expect(await db.select().from(trades).where(eq(trades.thesisId, result.id))).toHaveLength(0);
  });
  it('retries the same immutable submission without a second job or session refill', async () => {
    const f = await setup();
    const one = await submitThesis(db, f.user.id, f.input, now);
    expect(await submitThesis(db, f.user.id, f.input, now)).toEqual(one);
    await expect(submitThesis(db, f.user.id, { ...f.input, body: 'Changed content cannot reuse the same key.' }, now)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await db.select().from(thesisJobs).where(eq(thesisJobs.thesisId, one.id))).toHaveLength(1);
    // Leave this queued fixture terminal so it cannot be picked up by subsequent queue tests.
    await db.update(thesisJobs).set({ status: 'failed' }).where(eq(thesisJobs.thesisId, one.id));
  });
  it('publishes flagged content with its warnings and a single locked paper fill', async () => {
    const f = await setup(); await ready(f);
    const run = () => publishHuman(db, f.input.idempotencyKey, () => f.quote, { enabled: () => true, now: () => now });
    const trade = await run(); expect((await run()).id).toBe(trade.id);
    expect(trade).toMatchObject({ quantity: '10.0000', costUsd: '5.0000', mode: 'paper', locked: true });
    const view = await getThesisView(db, f.input.idempotencyKey);
    expect(view).toMatchObject({ status: 'published', audit: { verdict: 'flagged' }, position: { costUsd: '5.0000' }, publication: null });
    const [user] = await db.select().from(users).where(eq(users.id, f.user.id)); expect(user?.paperBalanceUsd).toBe('995.0000');
  });
  it('rejects stale, changed and mismatched books atomically', async () => {
    for (const mode of ['stale', 'changed', 'symbol']) {
      const f = await setup(); await ready(f); let reads = 0;
      const read = () => { reads++; return { ...f.quote, symbol: mode === 'symbol' ? 'wrong' : f.quote.symbol,
        observedAtMs: mode === 'stale' ? now - 10_001 : now,
        ask: mode === 'changed' && reads > 1 ? 0.51 : 0.5 }; };
      await expect(publishHuman(db, f.input.idempotencyKey, read, { enabled: () => true, now: () => now })).rejects.toThrow();
      expect(await db.select().from(trades).where(eq(trades.thesisId, f.input.idempotencyKey))).toHaveLength(0);
      const [user] = await db.select().from(users).where(eq(users.id, f.user.id)); expect(user?.paperBalanceUsd).toBe('1000.0000');
      await db.update(thesisJobs).set({ status: 'failed' }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
    }
  });
  it('enforces balance, daily cap, per-trade cap and the kill switch', async () => {
    for (const [change, code] of [[{ paperBalanceUsd: '1' }, 'insufficient_balance'], [{ dailyCopyCapUsd: '4' }, 'daily_limit'], [{ maxPerTradeUsd: '4' }, 'per_trade_limit'], [{}, 'trading_disabled']] as const) {
      const f = await setup(); await ready(f);
      if (Object.keys(change).length) await db.update(users).set(change).where(eq(users.id, f.user.id));
      await expect(publishHuman(db, f.input.idempotencyKey, () => f.quote, { enabled: () => code !== 'trading_disabled', now: () => now })).rejects.toMatchObject({ code });
      expect(await db.select().from(trades).where(eq(trades.thesisId, f.input.idempotencyKey))).toHaveLength(0);
      await db.update(thesisJobs).set({ status: 'failed' }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
    }
  });
  it('rejects a forecast inconsistent with the executable side', async () => {
    const f = await setup(); f.input.probabilityYes = 0.4; await ready(f);
    await expect(publishHuman(db, f.input.idempotencyKey, () => f.quote, { enabled: () => true, now: () => now })).rejects.toMatchObject({ code: 'probability_side' });
    await db.update(thesisJobs).set({ status: 'failed' }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
  });
  it('keeps unaudited theses out of execution', async () => {
    const f = await setup(); await submitThesis(db, f.user.id, f.input, now);
    await expect(publishHuman(db, f.input.idempotencyKey, () => f.quote, { enabled: () => true, now: () => now })).rejects.toMatchObject({ code: 'audit_required' });
    await db.update(thesisJobs).set({ status: 'failed' }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
  });
  it('does not claim paid work without a configured provider', async () => {
    expect(await processThesisJob(db, { quote: async () => { throw new Error('no quote'); }, enabled: () => true, now: () => now })).toEqual({ processed: false });
  });
  it('runs a queued audit and retains a contradicted claim on the public record', async () => {
    const f = await setup(); await submitThesis(db, f.user.id, f.input, now);
    const result = await processThesisJob(db, { provider: { audit: async () => checked },
      quote: async () => ({ read: () => f.quote, close() {} }), enabled: () => true, now: () => now });
    expect(result).toMatchObject({ processed: true, thesisId: f.input.idempotencyKey, verdict: 'flagged' });
    expect((await getThesisView(db, f.input.idempotencyKey))?.audit?.claims[0]?.status).toBe('contradicted');
  });
  it('model-blocked content never requests a quote or creates a position', async () => {
    const f = await setup(); await submitThesis(db, f.user.id, f.input, now);
    const result = await processThesisJob(db, { provider: { audit: async () => ({ ...checked, verdict: 'blocked', insideInfo: true }) },
      quote: async () => { throw new Error('must not request a quote'); }, enabled: () => true, now: () => now });
    expect(result).toMatchObject({ verdict: 'blocked' });
    expect(await db.select().from(trades).where(eq(trades.thesisId, f.input.idempotencyKey))).toHaveLength(0);
    expect(await getThesisView(db, f.input.idempotencyKey)).toBeNull();
  });
  it('records a fixed error code when audit fails and never leaks the exception', async () => {
    const f = await setup(); await submitThesis(db, f.user.id, f.input, now);
    await processThesisJob(db, { provider: { audit: async () => { throw new Error('secret upstream key'); } },
      quote: async () => { throw new Error('no quote'); }, enabled: () => true, now: () => now });
    const view = await getThesisView(db, f.input.idempotencyKey, f.user.id);
    expect(view).toMatchObject({ status: 'draft', publication: { status: 'failed', errorCode: 'audit_unavailable' } });
    expect(JSON.stringify(view)).not.toContain('secret upstream key');
  });
  it('settles an official winner exactly once, credits balance, and refunds voids', async () => {
    for (const voided of [false, true]) {
      const f = await setup(); await ready(f); await publishHuman(db, f.input.idempotencyKey, () => f.quote, { enabled: () => true, now: () => now });
      const client = { getEvent: async (ticker: string) => ticker === f.market.eventTicker ? ({ ticker, title: 'Fixture', status: voided ? 'invalid' : 'settled', contracts: [{ instrumentSymbol: f.input.symbol, ticker: 'UP', resolutionSide: 'yes' as const }] }) : null };
      expect(await settleHumans(db, client, now + 700_000)).toBe(1);
      expect(await settleHumans(db, client, now + 700_000)).toBe(0);
      const [user] = await db.select().from(users).where(eq(users.id, f.user.id)); expect(user?.paperBalanceUsd).toBe(voided ? '1000.0000' : '1005.0000');
    }
  });
  it('lists only public theses and rejects malformed feed cursors', async () => {
    const feed = await listThesisFeed(db, { kind: 'human' });
    expect(feed.theses.length).toBeGreaterThan(0);
    expect(feed.theses.every(t => ['published', 'resolved'].includes(t.status) && t.publication === null)).toBe(true);
    expect(JSON.stringify(feed)).not.toMatch(/paperBalanceUsd|circleWalletId|userId/);
    await expect(listThesisFeed(db, { kind: 'human', cursor: 'invalid' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
  it('recovers interrupted jobs without repeating paid work or hiding committed publication', async () => {
    const f = await setup(); await ready(f);
    await db.update(thesisJobs).set({ startedAt: new Date(now - 130_000) }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
    await processThesisJob(db, { provider: { audit: async () => { throw new Error('must not retry'); } },
      quote: async () => { throw new Error('must not quote'); }, enabled: () => true, now: () => now });
    const view = await getThesisView(db, f.input.idempotencyKey, f.user.id);
    expect(view).toMatchObject({ status: 'draft', publication: { status: 'failed', errorCode: 'audit_interrupted' } });
  });
  it('caps metered requests globally before claiming a new audit', async () => {
    const other = await createTestDb();
    try {
      const [user] = await other.db.insert(users).values({ displayName: 'Quota fixture' }).returning();
      const [author] = await other.db.insert(authors).values({ kind: 'human', userId: user!.id, displayName: 'Quota fixture' }).returning();
      const [market] = await other.db.insert(markets).values({ instrumentSymbol: 'GEMI-QUOTA', eventTicker: 'QUOTA', contractTicker: 'UP', title: 'Quota' }).returning();
      for (let i = 0; i < 21; i++) {
        const id = randomUUID();
        await other.db.insert(theses).values({ id, onchainId: id, authorId: author!.id, marketId: market!.id, headline: 'Fixture', body: 'Fixture', side: 'yes', probabilityYes: '0.7' });
        await other.db.insert(thesisJobs).values({ thesisId: id, stakeUsd: '1', status: i < 20 ? 'failed' : 'queued', startedAt: i < 20 ? new Date(now - 1000) : null });
      }
      const result = await processThesisJob(other.db, { provider: { audit: async () => { throw new Error('quota must prevent call'); } }, quote: async () => { throw new Error('no quote'); }, enabled: () => true, now: () => now });
      expect(result).toEqual({ processed: false });
    } finally { await other.close(); }
  });
  it('labels historical agent positions honestly and idempotently', async () => {
    const f = await setup(); const [author] = await db.insert(authors).values({ kind: 'agent', agentKey: 'legacy-test', displayName: 'Legacy test' }).returning();
    const [thesis] = await db.insert(theses).values({ authorId: author!.id, marketId: f.market.id, onchainId: 'legacy-test', headline: 'Legacy', body: 'Old position', side: 'yes', probabilityYes: '0.7', status: 'published', publishedAt: new Date(now) }).returning();
    expect(await flagLegacyTheses(db)).toBe(1); expect(await flagLegacyTheses(db)).toBe(0);
    expect((await getThesisView(db, thesis!.id))?.audit).toMatchObject({ verdict: 'flagged', model: 'legacy-review-v1' });
  });
});
