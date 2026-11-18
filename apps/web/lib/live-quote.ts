import { yesMidpoint, type StreamSocket } from '@thesis/core/browser';
import type { MarketView } from './market-view';

/**
 * Live quotes in the page, straight from Gemini's public WebSocket (no key, market data
 * only). This is the one place the browser talks to Gemini instead of our API: the odds on
 * short contracts move several cents a second, and a round trip through our database cannot
 * keep up with Gemini's own site. Everything else, and these same prices whenever the socket
 * is down, still comes from our API.
 */

/** Public market data host. Not a secret, so it may reach the browser. */
export const GEMINI_WS_URL = process.env.NEXT_PUBLIC_GEMINI_WS_URL ?? 'wss://ws.gemini.com';

export interface LiveQuote {
  bid: string | null;
  ask: string | null;
  last: string | null;
  /** When the page received it, in milliseconds. */
  at: number;
}

/** The part of the browser's WebSocket this module uses. Tests supply a stand-in. */
export interface BrowserWebSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

type Listener = (arg?: unknown) => void;

/**
 * Makes the browser's WebSocket look like the socket the shared stream client expects.
 * Two things differ from the `ws` package the worker uses:
 *
 * - A page cannot send a ping frame. The heartbeat is a LIST_SUBSCRIPTIONS request instead;
 *   Gemini's reply is a message, and any message counts as a sign of life.
 * - A page cannot drop a connection at once. `terminate` closes it and reports the close
 *   itself, because a dead connection may take a long time to report its own.
 */
export function browserSocket(
  WebSocketClass: new (url: string) => BrowserWebSocket,
): (url: string) => StreamSocket {
  return (url) => {
    const socket = new WebSocketClass(url);
    const listeners: Record<string, Listener[]> = {};
    let done = false;
    const emit = (event: string, arg?: unknown) => {
      if (done) return;
      if (event === 'close') done = true;
      for (const listener of listeners[event] ?? []) listener(arg);
    };

    socket.addEventListener('open', () => emit('open'));
    socket.addEventListener('close', () => emit('close'));
    socket.addEventListener('error', () => emit('error', new Error('WebSocket error')));
    socket.addEventListener('message', (event) => emit('message', String(event.data)));

    return {
      on(event: string, listener: (arg: never) => void) {
        (listeners[event] ??= []).push(listener as Listener);
      },
      send: (data) => socket.send(data),
      ping: () => socket.send(JSON.stringify({ id: 'heartbeat', method: 'LIST_SUBSCRIPTIONS' })),
      terminate() {
        socket.close();
        emit('close');
      },
    };
  };
}

/** The market as our API returned it, with its quote replaced by the live one when there is one. */
export function withLiveQuote(market: MarketView, quote: LiveQuote | undefined): MarketView {
  if (!quote) return market;
  return {
    ...market,
    yesBid: quote.bid,
    yesAsk: quote.ask,
    lastPrice: quote.last ?? market.lastPrice,
    yesMid: yesMidpoint({ bid: quote.bid, ask: quote.ask }),
  };
}
