/** Resumable local integration check: two explicitly labeled forecasts, $1 paper copies, 0.10 test USDC tips. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createGeminiPublicClient } from '../packages/core/src/index';
import { openPublicationQuote, sessionToken, sessionUser } from '../packages/services/src/index';
import { createDb, authors, eq, theses } from '../packages/db/src/index';
import { paperFill } from '../packages/services/src/money';
process.loadEnvFile(new URL('../.env', import.meta.url));
const origin = process.env.AGENT_UI_BASE_URL ?? 'http://127.0.0.1:3100';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
assert(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL!).hostname));
const path = new URL('../.local/phase4-live.json', import.meta.url);
type Actor = { cookie: string };
type Attempt = { symbol: string; eventTicker: string; expiryAt: string; thesisIds: Record<string, string>; copyIds: Record<string, string>; quoteTokens: Record<string, string> };
type State = { authors: Record<string, Actor>; copier?: Actor; attempts: Attempt[] };
let state: State;
try { state = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; state = { authors: {}, attempts: [] }; }
const save = () => writeFile(path, JSON.stringify(state));
async function request(url: string, actor?: Actor, body?: unknown) {
  const response = await fetch(`${origin}${url}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(actor ? { cookie: actor.cookie } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); return { response, data };
}
async function main() {
  const mode = process.argv[2] ?? 'prepare';
  if (mode === 'classify') {
    const connection = createDb(process.env.DATABASE_URL!, { max: 1 });
    try { for (const actor of Object.values(state.authors)) {
      const id = sessionUser(actor.cookie.slice('thesis_session='.length), process.env.SESSION_SECRET!);
      assert(id); await connection.db.update(authors).set({ isTest: true }).where(eq(authors.userId, id));
    }
    // This ID is the earlier, explicitly labeled Phase 3 publication acceptance fixture.
    const [legacy]=await connection.db.select({authorId:theses.authorId}).from(theses).where(eq(theses.id,'6a03e321-bc1f-4b87-b53f-9e59e1b20e4f'));
    if(legacy) await connection.db.update(authors).set({isTest:true}).where(eq(authors.id,legacy.authorId));
    } finally { await connection.close(); }
    console.log('Existing verification authors are labeled and excluded from rankings.'); return;
  }
  if (!state.copier) {
    const probe = JSON.parse(await readFile(new URL('../.local/wallet-probe.json', import.meta.url), 'utf8'));
    state.copier = { cookie: `thesis_session=${sessionToken(probe.userId, process.env.SESSION_SECRET!)}` }; await save();
  }
  if (mode === 'prepare') {
    for (const side of ['yes', 'no']) if (!state.authors[side]) {
      const { response } = await request('/api/session', undefined, { displayName: `Automated escrow ${side.toUpperCase()} test` });
      assert(response.ok); const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
      state.authors[side] = { cookie }; await save();
    }
    // Verification authors must never enter genuine performance rankings.
    const classification = createDb(process.env.DATABASE_URL!, { max: 1 });
    try { for (const actor of Object.values(state.authors)) {
      const id = sessionUser(actor.cookie.slice('thesis_session='.length), process.env.SESSION_SECRET!);
      assert(id); await classification.db.update(authors).set({ isTest: true }).where(eq(authors.userId, id));
    } } finally { await classification.close(); }
    let attempt = state.attempts.at(-1);
    if (!attempt || process.argv.includes('--new-window')) {
      attempt = undefined;
      const { response, data } = await request('/api/markets'); assert(response.ok);
      const client = createGeminiPublicClient({ logger: { warn() {} } });
      for (const market of data.markets.filter((m: { symbol: string; expiryAt: string; marketState: string }) => /^GEMI-(BTC|ETH)15M/.test(m.symbol) && m.marketState === 'open' && Date.parse(m.expiryAt) - Date.now() > 7 * 60_000)) {
        const lease = await openPublicationQuote(client, { eventTicker: market.eventTicker, instrumentSymbol: market.symbol });
        // Leave room for audit/registration latency; avoid nearly resolved books.
        try { const q = lease.read(); if (q && q.bid >= 0.20 && q.ask <= 0.80 && q.ask >= q.bid && q.ask - q.bid <= 0.060000001 &&
          paperFill(q.ask, q.askSize, q.quantityIncrement, q.quantityMinimum, 10_000n) &&
          paperFill(1 - q.bid, q.bidSize, q.quantityIncrement, q.quantityMinimum, 10_000n)) {
          attempt = { symbol: market.symbol, eventTicker: market.eventTicker, expiryAt: market.expiryAt,
            thesisIds: { yes: randomUUID(), no: randomUUID() }, copyIds: { yes: randomUUID(), no: randomUUID() }, quoteTokens: {} };
          state.attempts.push(attempt); await save(); break;
        } } finally { lease.close(); }
      }
    }
    assert(attempt && Date.parse(attempt.expiryAt) - Date.now() > 180_000, 'No eligible two-sided live BTC/ETH window. Wait for the next window; do not relax limits.');
    for (const side of ['yes', 'no']) {
      const { response, data } = await request('/api/theses', state.authors[side], { idempotencyKey: attempt.thesisIds[side], symbol: attempt.symbol,
        headline: `Automated escrow verification: ${side.toUpperCase()} paper position`,
        body: 'Automated escrow integration verification. Gemini offers prediction markets. This subjective forecast is only a test of publication, copying and settlement, not a claim of predictive skill or a guaranteed return.',
        side, probabilityYes: side === 'yes' ? 0.99 : 0.01, stakeUsd: '1', evidence: [{ claim: 'Gemini offers this prediction-market contract.', url: `https://www.gemini.com/predictions/${attempt.eventTicker}` }] });
      assert.equal(response.status, 202, data.message); console.log(JSON.stringify({ side, thesisId: data.id, status: data.status }));
    }
    return;
  }
  const attempt = state.attempts.at(-1); assert(attempt);
  const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), market: attempt.symbol, expiryAt: attempt.expiryAt, cases: {} };
  for (const side of ['yes', 'no']) {
    const thesis = await request(`/api/theses/${attempt.thesisIds[side]}`, state.authors[side]);
    assert(thesis.response.ok);
    if (mode === 'copy') {
      const existing = await request(`/api/copies/${attempt.copyIds[side]}`, state.copier);
      if (existing.response.status === 404) {
        assert.equal(thesis.data.thesis.status, 'published', `Waiting for ${side} publication: ${thesis.data.thesis.publication?.status}`);
        const quote = await request(`/api/theses/${attempt.thesisIds[side]}/quote`, state.copier, { amountUsd: '1', tipUsdc: '0.10' });
        assert(quote.response.ok, quote.data.message); attempt.quoteTokens[side] = quote.data.quoteToken; await save();
        const copied = await request(`/api/theses/${attempt.thesisIds[side]}/copy`, state.copier, { idempotencyKey: attempt.copyIds[side], amountUsd: '1', tipUsdc: '0.10', quoteToken: quote.data.quoteToken, acceptPriceMoved: quote.data.priceMoved });
        assert(copied.response.ok, copied.data.message);
      } else assert(existing.response.ok);
    }
    const copy = await request(`/api/copies/${attempt.copyIds[side]}`, state.copier);
    (evidence.cases as Record<string, unknown>)[side] = { thesisId: attempt.thesisIds[side], status: thesis.data.thesis.status,
      publication: thesis.data.thesis.publication, registerTx: thesis.data.thesis.registerTx, outcome: thesis.data.thesis.outcome,
      copy: copy.response.ok ? copy.data : null };
  }
  const cases = Object.values(evidence.cases as Record<string, any>);
  const completed = cases.every(c => c.copy?.trade.status === 'settled' && ['paid', 'refunded'].includes(c.copy?.tip?.status));
  evidence.completed = completed;
  if (completed || mode === 'replay') {
    if (completed) {
      assert.equal(cases.filter(c => c.copy.tip.status === 'paid').length, 1);
      assert.equal(cases.filter(c => c.copy.tip.status === 'refunded').length, 1);
    }
    assert(cases.some(c => c.copy), 'No existing copies to replay');
    const before = (await request('/api/me', state.copier)).data.paperBalanceUsd;
    for (const side of ['yes', 'no']) {
      if (!(evidence.cases as Record<string, any>)[side].copy) continue;
      const replay = await request(`/api/theses/${attempt.thesisIds[side]}/copy`, state.copier, { idempotencyKey: attempt.copyIds[side], amountUsd: '1', tipUsdc: '0.10', quoteToken: attempt.quoteTokens[side], acceptPriceMoved: true });
      assert(replay.response.ok, replay.data.message);
    }
    const after = (await request('/api/me', state.copier)).data.paperBalanceUsd;
    assert.equal(before, after); evidence.replayBalanceUnchanged = true;
  }
  await writeFile(new URL('../.local/phase4-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
main().catch(error => { console.error(error instanceof Error ? error.message.slice(0, 250) : 'Live verification pending'); process.exitCode = 2; });
