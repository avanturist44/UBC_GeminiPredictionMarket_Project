import { describe, expect, it } from 'vitest';
import {
  bookTickerStream,
  parseStreamMessage,
  streamSymbolKey,
  yesMidpoint,
  yesPrice,
} from '../src/index';

// Messages recorded from wss://ws.gemini.com on 2026-11-17 and 2026-11-18.
const TWO_SIDED =
  '{"u":1764531780480537,"E":1794971436327040662,"s":"gemi-btc15m2611180315-up","b":"0.8900","B":"5.00","a":"0.9500","A":"10.00","c":"0.8300","C":"5.00"}';
const NO_BID =
  '{"u":1764531780480217,"E":1794971435355847575,"s":"gemi-recession26-2026","b":"","B":"","a":"0.1100","A":"1877.00","c":"0.0400"}';
const NO_LAST_TRADE =
  '{"u":1764531769060255,"E":1794958351904397497,"s":"gemi-btc15m2611172345-up","b":"0.3700","B":"3.00","a":"0.4000","A":"5.00"}';

describe('parseStreamMessage', () => {
  it('reads a bookTicker message with both sides and the last trade', () => {
    expect(parseStreamMessage(TWO_SIDED)).toEqual({
      kind: 'bookTicker',
      ticker: {
        symbolKey: 'gemi-btc15m2611180315-up',
        bid: '0.8900',
        bidSize: '5.00',
        ask: '0.9500',
        askSize: '10.00',
        last: '0.8300',
      },
    });
  });

  it('turns an empty string into a missing side of the book', () => {
    expect(parseStreamMessage(NO_BID)).toMatchObject({
      kind: 'bookTicker',
      ticker: { bid: null, bidSize: null, ask: '0.1100', askSize: '1877.00', last: '0.0400' },
    });
  });

  it('reports no last trade when the message has none', () => {
    expect(parseStreamMessage(NO_LAST_TRADE)).toMatchObject({
      kind: 'bookTicker',
      ticker: { bid: '0.3700', ask: '0.4000', last: null },
    });
  });

  it('reads the reply to a subscribe request', () => {
    expect(parseStreamMessage('{"id":"1","status":200}')).toEqual({ kind: 'reply', id: '1', ok: true });
  });

  it('reads a refused request with Gemini’s reason', () => {
    expect(
      parseStreamMessage(
        '{"id":"4","status":400,"error":{"code":-1013,"msg":"Invalid stream name: GEMI-NOPE-NOPE@bookTicker"}}',
      ),
    ).toEqual({
      kind: 'reply',
      id: '4',
      ok: false,
      error: 'Invalid stream name: GEMI-NOPE-NOPE@bookTicker',
    });
  });

  it('ignores other streams, bad prices and text that is not JSON', () => {
    const indexPrice = '{"e":"thirdPartyPrice","E":1794958349,"s":"btcusd","p":"64903.90"}';
    expect(parseStreamMessage(indexPrice)).toEqual({ kind: 'other' });
    expect(parseStreamMessage(TWO_SIDED.replace('"0.8900"', '"abc"'))).toEqual({ kind: 'other' });
    expect(parseStreamMessage('not json')).toEqual({ kind: 'other' });
    expect(parseStreamMessage('null')).toEqual({ kind: 'other' });
  });
});

describe('stream names', () => {
  it('builds the stream name from the symbol exactly as Gemini returned it', () => {
    expect(bookTickerStream('GEMI-BTC15M2611180315-UP')).toBe('GEMI-BTC15M2611180315-UP@bookTicker');
  });

  it('matches a symbol to the lower-case form Gemini sends in messages', () => {
    expect(streamSymbolKey('GEMI-BTC15M2611180315-UP')).toBe('gemi-btc15m2611180315-up');
  });
});

describe('yesMidpoint', () => {
  it('is halfway between the bid and the ask', () => {
    expect(yesMidpoint({ bid: '0.22', ask: '0.29' })).toBe(0.255);
  });

  it('is unknown unless the book has both sides', () => {
    expect(yesMidpoint({ bid: null, ask: '0.11' })).toBeNull();
    expect(yesMidpoint({ bid: '0.5', ask: null })).toBeNull();
  });
});

describe('yesPrice', () => {
  it('is the midpoint when the book has both sides', () => {
    expect(yesPrice({ bid: '0.22', ask: '0.29', last: '0.40' })).toBe(0.255);
    expect(yesPrice({ bid: '0.8900', ask: '0.9500', last: null })).toBe(0.92);
  });

  it('falls back to the last trade when a side is missing', () => {
    expect(yesPrice({ bid: null, ask: '0.11', last: '0.04' })).toBe(0.04);
  });

  it('is unknown with one side and no trade: a lone quote is not a price', () => {
    expect(yesPrice({ bid: null, ask: '0.97', last: null })).toBeNull();
    expect(yesPrice({ bid: null, ask: null, last: null })).toBeNull();
  });
});
