import { describe, expect, it } from 'vitest';
import { browserSocket, withLiveQuote, type BrowserWebSocket } from '../lib/live-quote';
import type { MarketView } from '../lib/market-view';

/** A stand-in for the browser's WebSocket: records what was sent and lets a test fire events. */
class FakeBrowserSocket implements BrowserWebSocket {
  static last: FakeBrowserSocket;
  sent: string[] = [];
  closed = 0;
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};

  constructor(readonly url: string) {
    FakeBrowserSocket.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  fire(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

function open() {
  const socket = browserSocket(FakeBrowserSocket)('wss://example.test');
  const seen: string[] = [];
  socket.on('open', () => seen.push('open'));
  socket.on('close', () => seen.push('close'));
  socket.on('pong', () => seen.push('pong'));
  socket.on('error', (error) => seen.push(`error:${error.message}`));
  socket.on('message', (data) => seen.push(`message:${data.toString()}`));
  return { socket, browser: FakeBrowserSocket.last, seen };
}

describe('browserSocket', () => {
  it('connects to the address it is given and passes events on', () => {
    const { browser, seen } = open();
    expect(browser.url).toBe('wss://example.test');
    browser.fire('open');
    browser.fire('message', { data: '{"id":"1","status":200}' });
    browser.fire('error');
    browser.fire('close');
    expect(seen).toEqual(['open', 'message:{"id":"1","status":200}', 'error:WebSocket error', 'close']);
  });

  it('sends text as it is', () => {
    const { socket, browser } = open();
    socket.send('{"id":"1","method":"SUBSCRIBE","params":["X@bookTicker"]}');
    expect(browser.sent).toEqual(['{"id":"1","method":"SUBSCRIBE","params":["X@bookTicker"]}']);
  });

  it('asks Gemini for its subscription list as a heartbeat, since a page cannot send a ping', () => {
    const { socket, browser } = open();
    socket.ping();
    expect(JSON.parse(browser.sent[0]!)).toMatchObject({ method: 'LIST_SUBSCRIPTIONS' });
  });

  it('reports the close at once when it drops the connection, and only once', () => {
    const { socket, browser, seen } = open();
    browser.fire('open');
    socket.terminate();
    // A dead connection may never report its own close. The caller must not wait for it.
    expect(browser.closed).toBe(1);
    expect(seen).toEqual(['open', 'close']);
    browser.fire('close');
    browser.fire('message', { data: 'late' });
    expect(seen).toEqual(['open', 'close']);
  });
});

describe('withLiveQuote', () => {
  const market: MarketView = {
    symbol: 'GEMI-BTC15M2611180315-UP',
    eventTicker: 'BTC15M2611180315',
    title: 'BTC price today at 10:15pm EST',
    contractLabel: 'Up',
    category: 'Crypto',
    expiryAt: '2026-11-18T03:15:00.000Z',
    opensAt: '2026-11-18T03:00:00.000Z',
    marketState: 'open',
    strike: '64931.38',
    yesBid: '0.8900',
    yesAsk: '0.9500',
    lastPrice: '0.8300',
    yesMid: 0.92,
    resolutionSide: null,
    thesesYes: 0,
    thesesNo: 0,
    updatedAt: '2026-11-18T03:05:00.000Z',
  };

  it('leaves the market as read from our API when there is no live quote', () => {
    expect(withLiveQuote(market, undefined)).toBe(market);
  });

  it('replaces the quote and the midpoint with the live ones', () => {
    const live = withLiveQuote(market, { bid: '0.3100', ask: '0.3300', last: '0.3500', at: 1 });
    expect(live).toMatchObject({ yesBid: '0.3100', yesAsk: '0.3300', lastPrice: '0.3500', yesMid: 0.32 });
    expect(live.strike).toBe('64931.38');
  });

  it('shows an emptied side of the book, and keeps the last trade when the feed carries none', () => {
    const live = withLiveQuote(market, { bid: null, ask: '0.0700', last: null, at: 1 });
    expect(live).toMatchObject({ yesBid: null, yesAsk: '0.0700', lastPrice: '0.8300', yesMid: null });
  });
});
