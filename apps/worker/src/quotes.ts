import { streamSymbolKey, type BookTicker } from '@thesis/core';
import { recordStreamQuote, type Db, type LiveMarket } from '@thesis/db';
import type { Logger } from './recorder';

/**
 * Turns the stream's bookTicker messages into `price_points` rows: at most one row per
 * symbol every 10 seconds, always the newest quote, and none while the price is unchanged.
 *
 * `handle` only remembers the newest quote, so it is safe to call for every message.
 * `flush` does the writing and is called on a short timer, which is also what gets the last
 * quote of a burst written when no further message arrives.
 */

interface Quote {
  bid: string | null;
  ask: string | null;
  last: string | null;
}

interface Entry {
  marketId: string;
  instrumentSymbol: string;
  latest: Quote | null;
  written: Quote | null;
  /** The earliest time of the next write, in milliseconds. */
  notBefore: number;
}

export interface QuoteRecorderOptions {
  db: Db;
  logger: Logger;
  /** Minimum gap between rows for one symbol. */
  minIntervalMs?: number;
  now?: () => Date;
}

export interface QuoteRecorder {
  /** The contracts to record. Quotes for any other symbol are ignored. */
  setMarkets(markets: readonly LiveMarket[]): void;
  handle(ticker: BookTicker): void;
  /** Writes every quote that is due. Returns how many price points were stored. */
  flush(): Promise<number>;
  /** `written` counts price points stored since the worker started. */
  stats(): { written: number; tracked: number };
}

const same = (a: Quote, b: Quote | null) =>
  b !== null && a.bid === b.bid && a.ask === b.ask && a.last === b.last;

export function createQuoteRecorder(options: QuoteRecorderOptions): QuoteRecorder {
  const { db, logger } = options;
  const minIntervalMs = options.minIntervalMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  let entries = new Map<string, Entry>();
  let written = 0;
  let flushing = false;

  return {
    setMarkets(markets) {
      const next = new Map<string, Entry>();
      for (const market of markets) {
        const key = streamSymbolKey(market.instrumentSymbol);
        const existing = entries.get(key);
        next.set(
          key,
          existing && existing.marketId === market.id
            ? existing
            : {
                marketId: market.id,
                instrumentSymbol: market.instrumentSymbol,
                latest: null,
                written: null,
                notBefore: 0,
              },
        );
      }
      entries = next;
    },

    handle(ticker) {
      const entry = entries.get(ticker.symbolKey);
      if (entry) entry.latest = { bid: ticker.bid, ask: ticker.ask, last: ticker.last };
    },

    async flush() {
      // A slow database must not let two flushes write the same quote.
      if (flushing) return 0;
      flushing = true;
      let count = 0;
      try {
        for (const entry of entries.values()) {
          const quote = entry.latest;
          if (!quote || same(quote, entry.written)) continue;
          const at = now();
          if (at.getTime() < entry.notBefore) continue;
          try {
            const { point } = await recordStreamQuote(db, {
              marketId: entry.marketId,
              ts: at,
              yesBid: quote.bid,
              yesAsk: quote.ask,
              lastPrice: quote.last,
            });
            entry.written = quote;
            // Only a stored point starts the wait. An emptied book stores none, and the quote
            // that refills it a moment later should not have to wait ten seconds to be shown.
            if (point) {
              entry.notBefore = at.getTime() + minIntervalMs;
              count += 1;
            }
          } catch (error) {
            // The quote stays unwritten and is tried again after the usual wait, so a database
            // that is down is not hit, and does not fill the log, once a second per symbol.
            entry.notBefore = at.getTime() + minIntervalMs;
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`stream: could not store a quote for ${entry.instrumentSymbol}: ${message}`);
          }
        }
      } finally {
        flushing = false;
      }
      written += count;
      return count;
    },

    stats() {
      return { written, tracked: entries.size };
    },
  };
}
