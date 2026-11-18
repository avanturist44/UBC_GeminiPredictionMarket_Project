/** Public-data smoke check. Never submits orders or invents warmup observations. */
import { createGeminiPublicClient, DEFAULT_TRACKED_RULES, resolveEventTickers, parseStreamMessage } from '@thesis/core';
import WebSocket from 'ws';
import { BTC_INDEX_STREAM } from './momentum-observer';

const client = createGeminiPublicClient();
const rule = DEFAULT_TRACKED_RULES.find((r) => r.key === 'btc-15m')!;
const previousTicker = resolveEventTickers(rule, new Date(Date.now() - 15 * 60_000))[0]!;
const failures: string[] = [];
const report = (result: object) => console.log(JSON.stringify(result));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const checkedEvent = async (ticker: string, check: string) => {
  try { return await client.getEvent(ticker); }
  catch (error) {
    failures.push(check);
    report({ check, ok: false, error: errorText(error) });
    return null;
  }
};
const previous = await checkedEvent(previousTicker, 'official outcome');
const resolved = previous?.contracts.find((c) => c.ticker === 'UP');
if (previous) report({ check: 'official outcome', ok: !!resolved?.resolutionSide, ticker: previousTicker,
  resolutionSide: resolved?.resolutionSide ?? null, resolvedAt: resolved?.resolvedAt,
  settlementValue: resolved?.settlementValue });
if (previous && !resolved?.resolutionSide) failures.push('official outcome');
const ticker = resolveEventTickers(rule, new Date())[0]!;
const event = await checkedEvent(ticker, 'REST');
const contract = event?.contracts.find((c) => c.ticker === 'UP');
if (event && !contract) {
  failures.push('REST'); report({ check: 'REST', ok: false, error: `No current BTC contract: ${ticker}` });
}
if (contract) report({ check: 'REST', ok: true, ticker, status: contract.status, marketState: contract.marketState,
  source: event!.sourceDetails, strike: contract.strike, expiry: contract.expiryDate });
const symbol = contract?.instrumentSymbol ?? `GEMI-${ticker}-UP`;
const symbolSource = contract ? 'Gemini REST' : 'computed diagnostic subscription; REST unavailable';
await new Promise<void>((resolve) => {
  let book = false; let index = false; let done = false;
  const socket = new WebSocket('wss://ws.gemini.com');
  const finish = (error?: string) => {
    if (done) return;
    done = true; clearTimeout(timer);
    if (!book) failures.push('bookTicker');
    if (!index) failures.push('BTC index');
    if (error) report({ check: 'WebSocket', ok: false, error, book, index });
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    resolve();
  };
  const timer = setTimeout(() => finish('timed out waiting for fresh inputs'), 15_000);
  socket.on('error', (error) => finish(errorText(error)));
  socket.on('close', () => finish('socket closed before all inputs arrived'));
  socket.on('open', () => {
    // A refused book stream must not prevent the independent index subscription.
    socket.send(JSON.stringify({ id: 'btc-index', method: 'SUBSCRIBE', params: [BTC_INDEX_STREAM] }));
    socket.send(JSON.stringify({ id: 'btc-book', method: 'SUBSCRIBE', params: [`${symbol}@bookTicker`] }));
  });
  socket.on('message', (data) => {
    if (done) return;
    const text = data.toString(); const parsed = parseStreamMessage(text);
    if (parsed.kind === 'reply' && !parsed.ok) {
      report({ check: 'subscription', ok: false, id: parsed.id, error: parsed.error });
    }
    if (parsed.kind === 'bookTicker' && parsed.ticker.symbolKey === symbol.toLowerCase() && !book) {
      book = true; report({ check: 'bookTicker', ok: true, symbolSource, ...parsed.ticker });
    }
    try {
      const message = JSON.parse(text);
      if (!index && message.e === 'thirdPartyPrice' && message.s === 'btcusd' && message.I === 'LRRR_XBT') {
        const ageMs = Date.now() - message.E * 1000;
        index = Number.isFinite(Number(message.p)) && Number(message.p) > 0 && ageMs >= 0 && ageMs <= 10_000;
        report({ check: 'BTC index', ok: index, price: message.p, ageMs });
      }
    } catch { /* ignored by the production parser too */ }
    if (book && index) finish();
  });
});
report({ check: 'complete', ok: failures.length === 0, failedChecks: failures,
  note: 'Public input only. No Postgres, warmup, fills, or settlement verified.' });
if (failures.length) process.exitCode = 1;
