/** Public-data smoke check. Never submits orders or invents warmup observations. */
import { createGeminiPublicClient, DEFAULT_TRACKED_RULES, resolveEventTickers, parseStreamMessage } from '@thesis/core';
import WebSocket from 'ws';
import { BTC_INDEX_STREAM } from './momentum-observer';

const client = createGeminiPublicClient();
const rule = DEFAULT_TRACKED_RULES.find((r) => r.key === 'btc-15m')!;
const previousTicker = resolveEventTickers(rule, new Date(Date.now() - 15 * 60_000))[0]!;
const previous = await client.getEvent(previousTicker);
const resolved = previous?.contracts.find((c) => c.ticker === 'UP');
console.log(JSON.stringify({ check: 'official outcome', ticker: previousTicker,
  resolutionSide: resolved?.resolutionSide ?? null, resolvedAt: resolved?.resolvedAt,
  settlementValue: resolved?.settlementValue }));
const ticker = resolveEventTickers(rule, new Date())[0]!;
const event = await client.getEvent(ticker);
const contract = event?.contracts.find((c) => c.ticker === 'UP');
if (!contract) throw new Error(`No current BTC contract: ${ticker}`);
console.log(JSON.stringify({ check: 'REST', ticker, status: contract.status, marketState: contract.marketState,
  source: event!.sourceDetails, strike: contract.strike, expiry: contract.expiryDate }));
await new Promise<void>((resolve, reject) => {
  let book = false; let index = false;
  const socket = new WebSocket('wss://ws.gemini.com');
  const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Timed out: book=${book}, index=${index}`)); }, 25_000);
  const finish = () => { if (book && index) { clearTimeout(timer); socket.close(); resolve(); } };
  socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  socket.on('open', () => socket.send(JSON.stringify({ id: 'btc-smoke', method: 'SUBSCRIBE',
    params: [`${contract.instrumentSymbol}@bookTicker`, BTC_INDEX_STREAM] })));
  socket.on('message', (data) => {
    const text = data.toString(); const parsed = parseStreamMessage(text);
    if (parsed.kind === 'reply' && !parsed.ok) {
      clearTimeout(timer); socket.close(); reject(new Error(parsed.error)); return;
    }
    if (parsed.kind === 'bookTicker' && !book) {
      book = true; console.log(JSON.stringify({ check: 'bookTicker', ...parsed.ticker }));
    }
    try {
      const message = JSON.parse(text);
      if (!index && message.e === 'thirdPartyPrice' && message.s === 'btcusd' && message.I === 'LRRR_XBT') {
        index = true; console.log(JSON.stringify({ check: 'BTC index', price: message.p, ageMs: Date.now() - message.E * 1000 }));
      }
    } catch { /* ignored by the production parser too */ }
    finish();
  });
});
console.log(JSON.stringify({ check: 'complete', note: 'Public input only. No Postgres, warmup, fills, or settlement verified.' }));
