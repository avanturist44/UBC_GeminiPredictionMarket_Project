import { describe, expect, it } from 'vitest';
import { ago, sparkWindow, toSpark } from '../lib/spark';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe('sparkWindow', () => {
  it('starts before publication by half the thesis’s age, and ends now', () => {
    const window = sparkWindow({
      publishedAt: at('2026-11-19T04:00:00Z'),
      expiryAt: at('2026-11-19T22:00:00Z'),
      opensAt: null,
      now: at('2026-11-19T06:00:00Z'),
    });
    expect(window).toEqual({ from: at('2026-11-19T03:00:00Z'), to: at('2026-11-19T06:00:00Z') });
  });

  it('starts at least 15 minutes before a thesis published just now', () => {
    const window = sparkWindow({
      publishedAt: at('2026-11-19T04:00:00Z'),
      expiryAt: null,
      opensAt: null,
      now: at('2026-11-19T04:01:00Z'),
    });
    expect(window?.from.getTime()).toBe(Date.parse('2026-11-19T04:00:00Z') - 15 * MIN);
  });

  it('ends at expiry once the market has closed, and never starts before a short window opened', () => {
    const window = sparkWindow({
      publishedAt: at('2026-11-19T03:20:00Z'),
      expiryAt: at('2026-11-19T03:30:00Z'),
      opensAt: at('2026-11-19T03:15:00Z'),
      now: at('2026-11-19T09:00:00Z'),
    });
    expect(window).toEqual({ from: at('2026-11-19T03:15:00Z'), to: at('2026-11-19T03:30:00Z') });
  });

  it('has no window without a publish time', () => {
    expect(sparkWindow({ publishedAt: null, expiryAt: null, opensAt: null, now: new Date() })).toBeNull();
  });
});

describe('toSpark', () => {
  const window = { from: at('2026-11-19T00:00:00Z'), to: at('2026-11-19T01:00:00Z') };
  const point = (minute: number, yesBid: string | null, yesAsk: string | null, lastPrice: string | null = null) => ({
    ts: new Date(window.from.getTime() + minute * MIN),
    yesBid,
    yesAsk,
    lastPrice,
  });

  it('plots the midpoint for YES and one minus it for NO', () => {
    const points = [point(0, '0.60', '0.64'), point(30, '0.70', '0.74')];
    expect(toSpark(points, { side: 'yes', entryPrice: '0.64', publishedAt: window.from, ...window })?.points.map((p) => p.p)).toEqual([
      0.62, 0.72,
    ]);
    expect(toSpark(points, { side: 'no', entryPrice: '0.40', publishedAt: window.from, ...window })?.points.map((p) => p.p)).toEqual([
      0.38, 0.28,
    ]);
  });

  it('falls back to the last trade when a side of the book is empty, and skips points with neither', () => {
    const points = [point(0, null, '0.64', '0.61'), point(10, null, null, null), point(20, '0.70', null, null), point(30, '0.70', '0.72')];
    const spark = toSpark(points, { side: 'yes', entryPrice: null, publishedAt: null, ...window });
    expect(spark?.points.map((p) => p.p)).toEqual([0.61, 0.71]);
    expect(spark).toMatchObject({ entryPrice: null, entryT: null });
  });

  it('draws nothing from fewer than two usable points', () => {
    expect(toSpark([point(0, '0.6', '0.62')], { side: 'yes', entryPrice: '0.62', publishedAt: null, ...window })).toBeNull();
  });
});

describe('ago', () => {
  const now = at('2026-11-19T12:00:00Z');
  it('says how long ago in the largest whole unit', () => {
    expect(ago('2026-11-19T11:59:30Z', now)).toBe('now');
    expect(ago('2026-11-19T11:35:00Z', now)).toBe('25m');
    expect(ago('2026-11-19T09:00:00Z', now)).toBe('3h');
    expect(ago('2026-11-17T12:00:00Z', now)).toBe('2d');
    expect(ago(null, now)).toBe('');
  });
});
