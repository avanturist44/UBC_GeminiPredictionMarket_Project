/** Real two-connection checks in a temporary LOCAL database. Fixture data never enters live verification. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, audits, eq, markets, sql, thesisJobs, trades, users } from '../packages/db/src/index';
import { runMigrations } from '../packages/db/src/migrate';
import { createGuest, processThesisJob, publishHuman, settleHumans, submitThesis, type ExecutableQuote } from '../packages/services/src/index';
import { writeFile } from 'node:fs/promises';
process.loadEnvFile(new URL('../.env', import.meta.url));
const target = new URL(process.env.DATABASE_URL!);
assert(['localhost', '127.0.0.1'].includes(target.hostname), 'Local database required.');
const database = `thesis_publication_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(target); adminUrl.pathname = '/postgres';
const testUrl = new URL(target); testUrl.pathname = `/${database}`;
const admin = createDb(adminUrl.href, { max: 1 });
let first: ReturnType<typeof createDb> | undefined, second: ReturnType<typeof createDb> | undefined;
try {
  await admin.db.execute(sql.raw(`create database "${database}"`));
  await runMigrations(testUrl.href);
  first = createDb(testUrl.href, { max: 1 }); second = createDb(testUrl.href, { max: 1 });
  const db = first.db, other = second.db, now = Date.now();
  async function fixture(user = undefined as Awaited<ReturnType<typeof createGuest>> | undefined) {
    user ??= await createGuest(db, 'Concurrent fixture');
    const symbol = `GEMI-FIXTURE-${randomUUID()}`;
    const [market] = await db.insert(markets).values({ instrumentSymbol: symbol, eventTicker: symbol, contractTicker: 'UP', title: 'Fixture only',
      status: 'active', marketState: 'open', tracked: true, expiryAt: new Date(now + 600_000), quantityIncrement: '0.01', quantityMinimum: '0.01' }).returning();
    const input = { idempotencyKey: randomUUID(), symbol, headline: 'Concurrent fixture forecast', body: 'A fixture-only public prediction to verify accounting concurrency.',
      probabilityYes: 0.7, side: 'yes', stakeUsd: '5', evidence: [{ claim: 'Fixture source', url: 'https://example.com/facts' }] };
    await submitThesis(db, user.id, input, now);
    const quote: ExecutableQuote = { symbol, bid: 0.48, ask: 0.5, bidSize: 100, askSize: 100,
      observedAtMs: now, marketObservedAtMs: now, status: 'active', marketState: 'open', expiryMs: now + 600_000, quantityIncrement: '0.01', quantityMinimum: '0.01' };
    return { user, market: market!, input, quote };
  }
  async function ready(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(thesisJobs).set({ status: 'running', startedAt: new Date(now) }).where(eq(thesisJobs.thesisId, f.input.idempotencyKey));
    await db.insert(audits).values({ thesisId: f.input.idempotencyKey, verdict: 'pass', model: 'fixture-only', claims: [] });
  }
  const f = await fixture(); await ready(f);
  const simultaneous = await Promise.all([db, other].map(connection => publishHuman(connection, f.input.idempotencyKey, () => f.quote, { enabled: () => true, now: () => now })));
  assert.equal(simultaneous[0]!.id, simultaneous[1]!.id);
  assert.equal((await db.select().from(trades).where(eq(trades.thesisId, f.input.idempotencyKey))).length, 1);
  assert.equal((await db.select().from(users).where(eq(users.id, f.user.id)))[0]!.paperBalanceUsd, '995.0000');
  const limited = await fixture(); const contender = await fixture(limited.user);
  await ready(limited); await ready(contender);
  await db.update(users).set({ dailyCopyCapUsd: '5' }).where(eq(users.id, limited.user.id));
  const limits = await Promise.allSettled([[db, limited], [other, contender]].map(async ([connection, attempt]) => {
    const typed = attempt as typeof limited;
    return publishHuman(connection as typeof db, typed.input.idempotencyKey, () => typed.quote, { enabled: () => true, now: () => now });
  }));
  assert.equal(limits.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = limits.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'daily_limit');
  const queued = await fixture(); let calls = 0;
  const queuedResults = await Promise.all([db, other].map(connection => processThesisJob(connection, {
    provider: { audit: async () => { calls++; return { verdict: 'pass', insideInfo: false, model: 'fixture-only', claims: [] }; } },
    quote: async () => ({ read: () => queued.quote, close() {} }), enabled: () => true, now: () => now,
  })));
  assert.equal(calls, 1); assert.equal(queuedResults.filter(result => result.processed).length, 1);
  const client = { getEvent: async (ticker: string) => ticker === queued.market.eventTicker ? { ticker, title: 'Fixture only', status: 'settled',
    contracts: [{ ticker: 'UP', instrumentSymbol: queued.input.symbol, resolutionSide: 'yes' as const }] } : null };
  const payouts = await Promise.all([db, other].map(connection => settleHumans(connection, client, now + 700_000)));
  assert.equal(payouts.reduce((a,b) => a+b, 0), 1);
  assert.equal((await db.select().from(users).where(eq(users.id, queued.user.id)))[0]!.paperBalanceUsd, '1005.0000');
  const result = { checkedAt: new Date().toISOString(), passed: true, duplicateFill: 'one fill and one debit',
    concurrentLimit: 'one succeeds, one daily_limit', auditReservation: 'one fixture provider call',
    concurrentSettlement: 'one payout and one balance credit', temporaryDatabaseDropped: true, fixtureOnly: true };
  await writeFile(new URL('../.local/publication-concurrency.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await first?.close(); await second?.close();
  await admin.db.execute(sql.raw(`drop database if exists "${database}"`));
  await admin.close();
}
