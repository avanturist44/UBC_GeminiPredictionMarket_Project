/** Local acceptance: independently inspect the recorded official outcome, then replay settlement. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createGeminiPublicClient } from '../packages/core/src/index';
import { authors, createDb, eq, markets, theses, users } from '../packages/db/src/index';
import { getThesisView, settleHumans } from '../packages/services/src/index';
import { units } from '../packages/services/src/money';
process.loadEnvFile(new URL('../.env', import.meta.url));
const url = new URL(process.env.DATABASE_URL!);
assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Local verification database required.');
const saved = JSON.parse(await readFile(new URL('../.local/live-human-publication.json', import.meta.url), 'utf8'));
const id = process.argv[2] ?? saved.thesis?.id;
assert(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
const { db, close } = createDb(url.href, { max: 1 });
try {
  const view = await getThesisView(db, id);
  assert(view?.position && view.status === 'resolved', 'Official human settlement is still pending.');
  const [row] = await db.select({ market: markets, userId: authors.userId }).from(theses)
    .innerJoin(markets, eq(markets.id, theses.marketId)).innerJoin(authors, eq(authors.id, theses.authorId)).where(eq(theses.id, id));
  assert(row?.userId);
  const client = createGeminiPublicClient({ logger: { warn() {} } });
  const event = await client.getEvent(row.market.eventTicker);
  assert.equal(event?.ticker, row.market.eventTicker);
  const contract = event?.contracts.find(c => c.instrumentSymbol === row.market.instrumentSymbol);
  assert(contract);
  const voided = event?.status === 'invalid' || contract.status === 'invalid';
  assert(voided || contract.resolutionSide === 'yes' || contract.resolutionSide === 'no');
  const expected = voided ? units(view.position.costUsd) : contract.resolutionSide === view.side ? units(view.position.quantity) : 0n;
  assert.equal(units(view.position.payoutUsd!), expected);
  const [before] = await db.select().from(users).where(eq(users.id, row.userId));
  assert.equal(await settleHumans(db, client), 0);
  const [after] = await db.select().from(users).where(eq(users.id, row.userId));
  assert.equal(before?.paperBalanceUsd, after?.paperBalanceUsd);
  const result = { checkedAt: new Date().toISOString(), passed: true, thesisId: id,
    officialOutcome: voided ? 'void' : contract.resolutionSide, thesisOutcome: view.outcome,
    costUsd: view.position.costUsd, payoutUsd: view.position.payoutUsd,
    paperBalanceUsd: after?.paperBalanceUsd, replaySettlements: 0, balanceUnchangedOnReplay: true };
  await writeFile(new URL('../.local/live-human-settlement.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await close(); }
