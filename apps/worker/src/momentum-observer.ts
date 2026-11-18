import { streamSymbolKey, type BookTicker } from '@thesis/core';
import { agentRuns, and, eq, gt, markets, sql, type Db } from '@thesis/db';
import { evaluateMomentum, type MomentumInput } from './momentum';
import type { TradingAdapter } from './paper';

export const BTC_INDEX_STREAM = 'lukka:LS-LRRR-XBTUSD@indexPrice';
const minuteMs = 60_000;
const lookbackMinutes = 30;

export function createMomentumObserver(db: Db, options: { adapter?: TradingAdapter; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const quotes = new Map<string, NonNullable<MomentumInput['quote']>>();
  const closes = new Map<number, number>();
  let latestIndex: { price: number; observedAtMs: number } | undefined;

  function volatility(nowMs: number): number {
    const currentMinute = Math.floor(nowMs / minuteMs);
    const returns: number[] = [];
    for (let minute = currentMinute - lookbackMinutes; minute < currentMinute; minute++) {
      const previous = closes.get(minute - 1);
      const current = closes.get(minute);
      if (previous === undefined || current === undefined) return NaN;
      returns.push(Math.log(current / previous));
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1));
  }

  return {
    handleTicker(ticker: BookTicker, observedAtMs = Date.now()) {
      if (!/^gemi-btc15m\d+-up$/.test(ticker.symbolKey)) return;
      quotes.set(ticker.symbolKey, {
        observedAtMs,
        bid: Number(ticker.bid),
        ask: Number(ticker.ask),
        bidSize: Number(ticker.bidSize),
        askSize: Number(ticker.askSize),
      });
    },

    handleOther(text: string, receivedAtMs = Date.now()) {
      // The stream has already parsed this as JSON, but may also pass malformed messages.
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message?.e !== 'thirdPartyPrice' || message.s !== 'btcusd' ||
          message.I !== 'LRRR_XBT' || typeof message.p !== 'string' || typeof message.E !== 'number') return;
      const price = Number(message.p);
      const observedAtMs = message.E * 1000;
      if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(observedAtMs) ||
          observedAtMs > receivedAtMs || receivedAtMs - observedAtMs > 10_000 ||
          (latestIndex && observedAtMs < latestIndex.observedAtMs)) return;

      latestIndex = { price, observedAtMs };
      const minute = Math.floor(observedAtMs / minuteMs);
      closes.set(minute, price);
      for (const key of closes.keys()) {
        if (key < minute - lookbackMinutes - 1) closes.delete(key);
      }
    },

    async run() {
      const active = await db.select({
        id: markets.id,
        symbol: markets.instrumentSymbol,
        expiryAt: markets.expiryAt,
        state: markets.marketState,
        strike: markets.strike,
      }).from(markets).where(and(
        eq(markets.tracked, true),
        gt(markets.expiryAt, new Date(now())),
        sql`${markets.instrumentSymbol} ~ '^GEMI-BTC15M[0-9]+-UP$'`,
      ));
      const nowMs = now();
      for (const [symbol, quote] of quotes) {
        if (nowMs - quote.observedAtMs > 60_000) quotes.delete(symbol);
      }
      const inputFor = (market: typeof active[number]): MomentumInput => ({
          nowMs: now(),
          expiryMs: market.expiryAt?.getTime() ?? NaN,
          marketState: market.state,
          strike: Number(market.strike),
          indexPrice: latestIndex?.price ?? NaN,
          indexObservedAtMs: latestIndex?.observedAtMs ?? NaN,
          volatilityPerMinute: volatility(now()),
          quote: quotes.get(streamSymbolKey(market.symbol)) ?? null,
        });
      if (options.adapter) {
        for (const market of active) await options.adapter.execute(market.id, () => inputFor(market));
        return active.length;
      }
      const logs = active.map((market) => {
        const input = inputFor(market);
        const signal = evaluateMomentum(input);
        return {
          agentKey: 'momentum',
          marketId: market.id,
          // Trade rows and trade decisions are reserved for actual paper executions.
          decision: 'skip' as const,
          reason: signal.decision === 'trade' ? 'log only: hypothetical entry' : signal.reason,
          signal: { mode: 'log-only', ...signal, input },
          createdAt: new Date(now()),
        };
      });
      if (logs.length) await db.insert(agentRuns).values(logs);
      return logs.length;
    },
  };
}
