import { streamSymbolKey, type BookTicker } from '@thesis/core';
import { recordStreamQuote, updateMarketQuote, type Db, type LiveMarket } from '@thesis/db';
import type { Logger } from './recorder';

/**
 * Stores what the stream's bookTicker messages say, at two speeds:
 *
 * - the market's current quote is updated as soon as it changes, so pages show a move within
 *   about a second;
 * - `price_points` gets at most one row per symbol every 10 seconds, always the newest quote,
 *   and none while the price is unchanged.
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
  /** The quote the market row holds. */
  shown: Quote | null;
  /** The quote of the last price point stored. */
  charted: Quote | null;
  /** The earliest time of the next price point, in milliseconds. */
  pointNotBefore: number;
  /** After a failed write, nothing is written for this symbol before this time. */
  retryNotBefore: number;
}

export interface QuoteRecorderOptions {
  db: Db;
  logger: Logger;
  /** Minimum gap between price points for one symbol. */
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
                shown: null,
                charted: null,
                pointNotBefore: 0,
                retryNotBefore: 0,
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
          if (!quote) continue;
          const at = now();
          const time = at.getTime();
          if (time < entry.retryNotBefore) continue;
          // An emptied book with no trade has no price to chart.
          const hasPrice = quote.bid !== null || quote.ask !== null || quote.last !== null;
          const pointDue = hasPrice && !same(quote, entry.charted) && time >= entry.pointNotBefore;
          if (!pointDue && same(quote, entry.shown)) continue;
          const stored = { marketId: entry.marketId, yesBid: quote.bid, yesAsk: quote.ask, lastPrice: quote.last };
          try {
            if (pointDue) {
              await recordStreamQuote(db, { ...stored, ts: at });
              entry.charted = quote;
              entry.pointNotBefore = time + minIntervalMs;
              count += 1;
            } else {
              await updateMarketQuote(db, stored);
            }
            entry.shown = quote;
          } catch (error) {
            // The quote stays unwritten and is tried again after the usual wait, so a database
            // that is down is not hit, and does not fill the log, once a second per symbol.
            entry.retryNotBefore = time + minIntervalMs;
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
