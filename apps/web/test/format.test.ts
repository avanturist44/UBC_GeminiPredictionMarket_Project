import { describe, expect, it } from 'vitest';
import { cents, noBuyPrice, percent, timeLeft, timeTicks } from '../lib/format';

describe('cents', () => {
  it('shows a price between 0 and 1 as whole cents', () => {
    expect(cents('0.62')).toBe('62¢');
    expect(cents('0.8900')).toBe('89¢');
    expect(cents(0.255)).toBe('26¢');
    expect(cents('0.004')).toBe('0¢');
    expect(cents('1')).toBe('100¢');
  });

  it('rounds a half cent up every time, whatever the float underneath', () => {
    // Midpoints of quotes one cent apart. 0.285 * 100 is 28.499999999999996 in floating point.
    expect(cents(0.285)).toBe('29¢');
    expect(cents(0.575)).toBe('58¢');
    expect(cents(0.505)).toBe('51¢');
    expect(cents(0.035)).toBe('4¢');
    expect(cents('0.145')).toBe('15¢');
  });

  it('shows a dash when there is no price', () => {
    expect(cents(null)).toBe('–');
  });
});

describe('noBuyPrice', () => {
  it('is one dollar minus the YES bid, as Gemini quotes NO', () => {
    expect(noBuyPrice('0.89')).toBe(0.11);
    expect(noBuyPrice('0.04')).toBe(0.96);
    expect(noBuyPrice('0.3700')).toBe(0.63);
  });

  it('is unknown without a YES bid', () => {
    expect(noBuyPrice(null)).toBeNull();
  });
});

describe('percent', () => {
  it('shows a probability as a whole percentage', () => {
    expect(percent(0.615)).toBe('62%');
    expect(percent(0.285)).toBe('29%');
    expect(percent('0.3000')).toBe('30%');
    expect(percent(null)).toBe('–');
  });
});

describe('timeLeft', () => {
  const now = new Date('2026-11-18T03:00:00Z');
  const inMs = (ms: number) => new Date(now.getTime() + ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it('counts down in minutes and seconds under an hour', () => {
    expect(timeLeft(inMs(12 * MIN + 34_000), now)).toEqual({ text: '12:34', soon: true, over: false });
    expect(timeLeft(inMs(59 * MIN + 59_000), now)).toMatchObject({ text: '59:59' });
    expect(timeLeft(inMs(5_400), now)).toMatchObject({ text: '0:05' });
  });

  it('shows hours and minutes under two days', () => {
    expect(timeLeft(inMs(HOUR), now)).toEqual({ text: '1h 0m', soon: false, over: false });
    expect(timeLeft(inMs(19 * HOUR + 5 * MIN), now)).toMatchObject({ text: '19h 5m' });
  });

  it('shows days beyond that', () => {
    expect(timeLeft(inMs(48 * HOUR), now)).toMatchObject({ text: '2 days' });
    expect(timeLeft(inMs(75 * 24 * HOUR + HOUR), now)).toMatchObject({ text: '75 days' });
  });

  it('says so once the time has passed', () => {
    expect(timeLeft(now, now)).toEqual({ text: 'Closed', soon: false, over: true });
    expect(timeLeft(inMs(-5 * MIN), now)).toMatchObject({ over: true });
  });

  it('handles a market with no expiry', () => {
    expect(timeLeft(null, now)).toEqual({ text: 'No end date', soon: false, over: false });
  });
});

describe('timeTicks', () => {
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 18, h, m, s);

  it('puts a few ticks on round minutes for a short chart', () => {
    expect(timeTicks(at(3, 17, 31), at(3, 29, 50))).toEqual([at(3, 20), at(3, 25)]);
  });

  it('uses round hours for a chart of a few hours', () => {
    expect(timeTicks(at(14, 12), at(19, 24))).toEqual([at(16, 0), at(18, 0)]);
  });

  it('never returns more ticks than asked for', () => {
    for (const minutes of [1, 7, 44, 90, 600, 5000, 50_000, 500_000]) {
      const ticks = timeTicks(at(0, 0, 1), at(0, 0, 1) + minutes * 60_000);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
  });

  it('returns nothing for an empty range', () => {
    expect(timeTicks(at(3, 0), at(3, 0))).toEqual([]);
  });
});
