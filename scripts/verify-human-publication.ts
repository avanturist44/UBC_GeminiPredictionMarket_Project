/** One explicitly labeled automated $1-paper-budget publication through the real local HTTP/worker path. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createGeminiPublicClient } from '../packages/core/src/index';
import { openPublicationQuote } from '../packages/services/src/human-paper';
import { paperFill } from '../packages/services/src/money';
import type { ThesisView } from '../packages/services/src/feed';
process.loadEnvFile(new URL('../.env', import.meta.url));
assert(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL!).hostname), 'Local database required.');
const origin = process.env.AGENT_UI_BASE_URL ?? 'http://127.0.0.1:3100';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Local server required.');
const client = createGeminiPublicClient({ logger: { warn() {} } });
const marketResponse = await fetch(`${origin}/api/markets`);
assert(marketResponse.ok);
const { markets } = await marketResponse.json() as { markets: { symbol: string; eventTicker: string; expiryAt: string; marketState: string }[] };
let selected: { symbol: string; eventTicker: string; probability: number } | undefined;
for (const market of markets.filter(m => m.marketState === 'open' && Date.parse(m.expiryAt) - Date.now() > 360_000).sort((a,b) => Date.parse(a.expiryAt) - Date.parse(b.expiryAt)).slice(0, 6)) {
  try {
    const lease = await openPublicationQuote(client, { instrumentSymbol: market.symbol, eventTicker: market.eventTicker });
    try {
      const quote = lease.read();
      if (quote && quote.bid > 0 && quote.ask >= quote.bid && quote.ask - quote.bid <= 0.060000001 &&
        paperFill(quote.ask, quote.askSize, quote.quantityIncrement, quote.quantityMinimum, 10_000n)) {
        selected = { symbol: market.symbol, eventTicker: market.eventTicker,
          probability: Math.min(0.99, Math.round((quote.ask + 0.1) * 100) / 100) };
      }
    } finally { lease.close(); }
    if (selected) break;
  } catch { /* A one-sided/unavailable book is not an executable test candidate. */ }
}
if (!selected) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), passed: false, reason: 'No qualifying live book; limits were preserved.' }));
  process.exit(2);
}
const session = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Automated publication verification' }) });
assert(session.ok);
const cookie = session.headers.get('set-cookie')?.split(';')[0];
assert(cookie);
const headers = { origin, cookie, 'content-type': 'application/json' };
const input = { idempotencyKey: randomUUID(), symbol: selected.symbol,
  headline: 'Automated integration check: subjective YES forecast',
  body: 'Automated publication verification using a small paper position. Gemini offers prediction markets. My YES forecast is subjective and is used only to exercise this integration; it is not a claim of predictive skill or a guaranteed return.',
  side: 'yes', probabilityYes: selected.probability, stakeUsd: '1',
  evidence: [{ claim: 'Gemini offers this prediction-market contract.', url: `https://www.gemini.com/predictions/${selected.eventTicker}` }] };
const submit = () => fetch(`${origin}/api/theses`, { method: 'POST', headers, body: JSON.stringify(input) });
const submitted = await submit();
assert.equal(submitted.status, 202);
const deadline = Date.now() + 135_000;
let thesis: ThesisView | undefined;
while (Date.now() < deadline) {
  const response = await fetch(`${origin}/api/theses/${input.idempotencyKey}`, { headers: { cookie } });
  assert(response.ok);
  thesis = ((await response.json()) as { thesis: ThesisView }).thesis;
  if (thesis.status !== 'auditing') break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
const passed = !!thesis && ['published', 'resolved'].includes(thesis.status) && thesis.position?.mode === 'paper' &&
  thesis.position.locked && ['pass', 'flagged'].includes(thesis.audit?.verdict ?? '');
let replayPassed = false;
if (passed) {
  const before = await (await fetch(`${origin}/api/me`, { headers: { cookie } })).json() as { paperBalanceUsd: string };
  const replay = await submit();
  const after = await (await fetch(`${origin}/api/me`, { headers: { cookie } })).json() as { paperBalanceUsd: string };
  assert.equal(replay.status, 202); assert.equal(before.paperBalanceUsd, after.paperBalanceUsd);
  assert.equal((await fetch(`${origin}/api/theses/${input.idempotencyKey}`)).status, 200);
  replayPassed = true;
}
const result = { checkedAt: new Date().toISOString(), passed, replayPassed, thesis,
  note: 'Automated integration-verification guest, not a human-authored forecast or evidence of strategy profitability. $1 paper budget; real Gemini quote and real Grok audit. No USDC or real funds.' };
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/live-human-publication.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 2;
