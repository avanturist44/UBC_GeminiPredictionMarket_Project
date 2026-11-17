import { describe, expect, it } from 'vitest';
import { formatTickerTime, rollingEventTickers } from '../src/index';

const at = (iso: string) => new Date(iso);

describe('formatTickerTime', () => {
  it('formats YYMMDDHHmm in UTC', () => {
    expect(formatTickerTime(at('2026-11-17T07:45:00Z'))).toBe('2611170745');
    expect(formatTickerTime(at('2027-01-01T00:00:00Z'))).toBe('2701010000');
  });
});

describe('rollingEventTickers', () => {
  const btc15 = { prefix: 'BTC15M', periodMinutes: 15, offsetMinutes: 0, count: 2 };

  it('returns the current and next 15-minute events', () => {
    // Matches the tickers Gemini listed at this moment in Phase 0.
    expect(rollingEventTickers(btc15, at('2026-11-17T07:27:13Z'))).toEqual([
      'BTC15M2611170730',
      'BTC15M2611170745',
    ]);
  });

  it('treats an event as over at its expiry instant', () => {
    expect(rollingEventTickers(btc15, at('2026-11-17T07:30:00Z'))).toEqual([
      'BTC15M2611170745',
      'BTC15M2611170800',
    ]);
    expect(rollingEventTickers(btc15, at('2026-11-17T07:29:59.999Z'))[0]).toBe('BTC15M2611170730');
  });

  it('rolls over day, month and year', () => {
    expect(rollingEventTickers(btc15, at('2026-12-31T23:50:00Z'))).toEqual([
      'BTC15M2701010000',
      'BTC15M2701010015',
    ]);
  });

  it('handles daily events that expire at 22:00 UTC', () => {
    const daily = { prefix: 'BTC', periodMinutes: 1440, offsetMinutes: 22 * 60, count: 1 };
    expect(rollingEventTickers(daily, at('2026-11-17T07:27:00Z'))).toEqual(['BTC2611172200']);
    expect(rollingEventTickers(daily, at('2026-11-17T22:30:00Z'))).toEqual(['BTC2611182200']);
  });

  it('handles daily events that expire at 04:59 UTC, with a dash in the prefix', () => {
    const nyc = { prefix: 'WXHIGH-NYC-', periodMinutes: 1440, offsetMinutes: 4 * 60 + 59, count: 1 };
    expect(rollingEventTickers(nyc, at('2026-11-17T07:27:00Z'))).toEqual(['WXHIGH-NYC-2611180459']);
  });
});
