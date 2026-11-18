import type { BookTicker } from '@thesis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPriceStream, type StreamSocket } from '../src/stream';

/** A stand-in for the `ws` socket: records what was sent and lets a test play the server. */
class FakeSocket implements StreamSocket {
  sent: Array<{ id: string; method: string; params: string[] }> = [];
  pings = 0;
  terminated = false;
  private listeners: Record<string, Array<(arg?: unknown) => void>> = {};

  // Typed loosely on purpose: the test plays every event by name.
  on(event: string, listener: (arg: never) => void): void {
    (this.listeners[event] ??= []).push(listener as (arg?: unknown) => void);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('close');
  }
  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners[event] ?? []) listener(arg);
  }
  /** The server accepts the connection. */
  open(): void {
    this.emit('open');
  }
  /** The server sends a text frame. */
  receive(message: object): void {
    this.emit('message', JSON.stringify(message));
  }
  /** The connection drops. */
  drop(): void {
    this.emit('close');
  }
  requests(method: string): string[][] {
    return this.sent.filter((r) => r.method === method).map((r) => r.params);
  }
}

const A = 'GEMI-BTC15M2611180315-UP';
const B = 'GEMI-ETH15M2611180315-UP';
const C = 'GEMI-RECESSION26-2026';
const stream = (symbol: string) => `${symbol}@bookTicker`;

let sockets: FakeSocket[];
let tickers: BookTicker[];
let warnings: string[];
const logger = {
  info: () => {},
  warn: (message: string) => warnings.push(message),
  error: (message: string) => warnings.push(message),
};

function start(symbols: string[] = []) {
  const priceStream = createPriceStream({
    url: 'wss://example.test',
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onTicker: (ticker) => tickers.push(ticker),
    logger,
  });
  priceStream.setSymbols(symbols);
  priceStream.start();
  return priceStream;
}

const latest = () => sockets.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  tickers = [];
  warnings = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPriceStream', () => {
  it('subscribes to every tracked symbol once the socket opens', () => {
    const priceStream = start([A, B]);
    expect(sockets).toHaveLength(1);
    expect(latest().sent).toEqual([]);

    latest().open();
    expect(latest().requests('SUBSCRIBE')).toEqual([[stream(A), stream(B)]]);
    expect(priceStream.status()).toMatchObject({ connected: true, subscribed: 2 });
  });

  it('passes bookTicker messages on and ignores everything else', () => {
    start([A]);
    latest().open();
    latest().receive({ id: '1', status: 200 });
    latest().receive({ e: 'thirdPartyPrice', s: 'btcusd', p: '64903.9' });
    latest().receive({ s: 'gemi-btc15m2611180315-up', b: '0.8900', B: '5.00', a: '0.9500', A: '10.00', c: '0.8300' });

    expect(tickers).toEqual([
      {
        symbolKey: 'gemi-btc15m2611180315-up',
        bid: '0.8900',
        bidSize: '5.00',
        ask: '0.9500',
        askSize: '10.00',
        last: '0.8300',
      },
    ]);
  });

  it('subscribes to new symbols and unsubscribes from ones that are gone', () => {
    const priceStream = start([A, B]);
    latest().open();
    priceStream.setSymbols([B, C]);

    expect(latest().requests('SUBSCRIBE')).toEqual([[stream(A), stream(B)], [stream(C)]]);
    expect(latest().requests('UNSUBSCRIBE')).toEqual([[stream(A)]]);
    expect(priceStream.status()).toMatchObject({ subscribed: 2 });

    // Nothing changed: nothing is sent.
    priceStream.setSymbols([C, B]);
    expect(latest().sent).toHaveLength(3);
  });

  it('retries each stream alone when Gemini refuses a request, so one bad name costs one stream', () => {
    const priceStream = start([A, 'GEMI-NOPE-NOPE']);
    latest().open();
    const [first] = latest().sent;
    latest().receive({
      id: first!.id,
      status: 400,
      error: { code: -1013, msg: 'Invalid stream name: GEMI-NOPE-NOPE@bookTicker' },
    });

    expect(latest().requests('SUBSCRIBE').slice(1)).toEqual([[stream(A)], [stream('GEMI-NOPE-NOPE')]]);

    // The bad one is refused again: it is reported and left alone.
    const retryOfBad = latest().sent.at(-1)!;
    latest().receive({
      id: retryOfBad.id,
      status: 400,
      error: { code: -1013, msg: 'Invalid stream name: GEMI-NOPE-NOPE@bookTicker' },
    });
    expect(latest().sent).toHaveLength(3);
    expect(warnings.join('\n')).toContain('GEMI-NOPE-NOPE');
    expect(priceStream.status()).toMatchObject({ subscribed: 1 });

    // It is not asked for again on every sync.
    priceStream.setSymbols([A, 'GEMI-NOPE-NOPE']);
    expect(latest().sent).toHaveLength(3);

    // A minute later it gets another try, in case Gemini had not listed the stream yet.
    latest().emit('pong');
    vi.advanceTimersByTime(30_000);
    latest().emit('pong');
    vi.advanceTimersByTime(30_000);
    priceStream.setSymbols([A, 'GEMI-NOPE-NOPE']);
    expect(latest().requests('SUBSCRIBE').at(-1)).toEqual([stream('GEMI-NOPE-NOPE')]);
    expect(latest().sent).toHaveLength(4);
  });

  it('reconnects after the socket drops and subscribes again', () => {
    const priceStream = start([A]);
    latest().open();
    latest().drop();
    expect(priceStream.status()).toMatchObject({ connected: false, subscribed: 0 });
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    latest().open();
    expect(latest().requests('SUBSCRIBE')).toEqual([[stream(A)]]);
    expect(priceStream.status()).toMatchObject({ connected: true, subscribed: 1, reconnects: 1 });
  });

  it('does not count a failed attempt as a reconnect, and names a refused connection', () => {
    const priceStream = start([A]);
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().emit('error', Object.assign(new Error(''), { code: 'ECONNREFUSED' }));
    latest().drop();
    expect(priceStream.status()).toMatchObject({ connected: false, reconnects: 0 });
    expect(warnings.at(-1)).toContain('ECONNREFUSED');
  });

  it('uses the symbols set while it was disconnected', () => {
    const priceStream = start([A]);
    latest().open();
    latest().drop();
    priceStream.setSymbols([B]);
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(latest().requests('SUBSCRIBE')).toEqual([[stream(B)]]);
    expect(latest().requests('UNSUBSCRIBE')).toEqual([]);
  });

  it('waits longer after each failed attempt, up to 30 seconds, and starts over once data flows', () => {
    start([A]);
    // Every attempt fails before it opens.
    const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const wait of waits) {
      const before = sockets.length;
      latest().emit('error', new Error('connect failed'));
      latest().drop();
      vi.advanceTimersByTime(wait - 1);
      expect(sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
    }

    expect(warnings.at(-1)).toContain('connect failed');

    // A connection that delivers data resets the wait.
    latest().open();
    latest().receive({ id: '1', status: 200 });
    const before = sockets.length;
    latest().drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(before + 1);
  });

  it('pings on a timer, and drops a socket that has gone silent', () => {
    const priceStream = start([A]);
    latest().open();
    const first = latest();

    vi.advanceTimersByTime(15_000);
    expect(first.pings).toBe(1);
    first.emit('pong');
    vi.advanceTimersByTime(15_000);
    first.emit('pong');
    vi.advanceTimersByTime(15_000);
    expect(first.terminated).toBe(false);

    // No pong and no message from here on: the connection is dead but never closed.
    vi.advanceTimersByTime(45_000);
    expect(first.terminated).toBe(true);
    expect(priceStream.status()).toMatchObject({ connected: false });

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('ignores late events from a socket it has already replaced', () => {
    const priceStream = start([A]);
    const first = latest();
    first.open();
    first.drop();
    vi.advanceTimersByTime(1000);
    latest().open();

    first.drop();
    first.receive({ s: 'gemi-btc15m2611180315-up', b: '0.1', a: '0.2' });
    expect(priceStream.status()).toMatchObject({ connected: true, reconnects: 1 });
    expect(tickers).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);
  });

  it('subscribes to extra streams and hands their messages on as text', () => {
    const other: string[] = [];
    const priceStream = createPriceStream({
      url: 'wss://example.test',
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onTicker: (ticker) => tickers.push(ticker),
      extraStreams: ['lukka:LS-LRRR-XBTUSD@indexPrice'],
      onOther: (text) => other.push(text),
      logger,
    });
    priceStream.setSymbols([A]);
    priceStream.start();
    latest().open();
    expect(latest().requests('SUBSCRIBE')).toEqual([[stream(A), 'lukka:LS-LRRR-XBTUSD@indexPrice']]);
    latest().receive({ e: 'thirdPartyPrice', s: 'btcusd', p: '64903.9' });
    latest().receive({ id: '1', status: 200 });
    expect(other).toEqual(['{"e":"thirdPartyPrice","s":"btcusd","p":"64903.9"}']);
    priceStream.stop();
  });

  it('stops for good: no reconnect after stop', () => {
    const priceStream = start([A]);
    latest().open();
    priceStream.stop();
    expect(latest().terminated).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });
});
