'use client';

import { createPriceStream, streamSymbolKey, type PriceStream } from '@thesis/core/browser';
import { useEffect, useRef, useState } from 'react';
import { GEMINI_WS_URL, browserSocket, type LiveQuote } from './live-quote';

/** How often received quotes are put on screen. The feed sends several messages a second. */
const PAINT_INTERVAL_MS = 250;

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const NO_QUOTES: ReadonlyMap<string, LiveQuote> = new Map();

export interface LiveQuotes {
  /** True while the page's own connection to Gemini is up. */
  connected: boolean;
  /** The live quote for a symbol, or undefined: then show what our API returned. */
  quoteFor: (instrumentSymbol: string) => LiveQuote | undefined;
}

/**
 * Live quotes for the given instrument symbols, from the page's own connection to Gemini's
 * public stream. The connection reconnects by itself. While it is down this returns no
 * quotes at all, so the page falls back to our API instead of showing stale prices.
 */
export function useLiveQuotes(symbols: readonly string[]): LiveQuotes {
  const [state, setState] = useState({ quotes: NO_QUOTES, connected: false });
  const streamRef = useRef<PriceStream | null>(null);
  const wanted = [...symbols].sort().join(',');

  useEffect(() => {
    const latest = new Map<string, LiveQuote>();
    let dirty = false;
    let shownConnected = false;

    const stream = createPriceStream({
      url: GEMINI_WS_URL,
      connect: browserSocket(WebSocket),
      logger: QUIET,
      onTicker: (ticker) => {
        latest.set(ticker.symbolKey, {
          bid: ticker.bid,
          ask: ticker.ask,
          last: ticker.last,
          at: Date.now(),
        });
        dirty = true;
      },
    });
    streamRef.current = stream;
    stream.start();

    const timer = setInterval(() => {
      const connected = stream.status().connected;
      // Quotes from a connection that has dropped are no longer current.
      if (!connected && latest.size > 0) {
        latest.clear();
        dirty = true;
      }
      if (!dirty && connected === shownConnected) return;
      dirty = false;
      shownConnected = connected;
      setState({ quotes: new Map(latest), connected });
    }, PAINT_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      stream.stop();
      streamRef.current = null;
    };
  }, []);

  // Runs after the effect above on the first render, and again whenever the symbols change.
  useEffect(() => {
    streamRef.current?.setSymbols(wanted === '' ? [] : wanted.split(','));
  }, [wanted]);

  return {
    connected: state.connected,
    quoteFor: (instrumentSymbol) => state.quotes.get(streamSymbolKey(instrumentSymbol)),
  };
}
