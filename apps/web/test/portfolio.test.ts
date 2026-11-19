import type { PortfolioData, ValuationMarket, ValuedTrade } from '@thesis/db';
import { describe, expect, it } from 'vitest';
import { buildPortfolio } from '../lib/portfolio';

const T0 = new Date('2026-11-19T10:00:00Z');
const NOW = new Date('2026-11-19T12:00:00Z');
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const market = (id: string, over: Partial<ValuationMarket> = {}): ValuationMarket => ({
  id,
  instrumentSymbol: `GEMI-${id}`,
  title: `Market ${id}`,
  contractLabel: null,
  yesBid: '0.50',
  yesAsk: '0.60',
  lastPrice: null,
  resolutionSide: null,
  resolvedAt: null,
  status: 'active',
  ...over,
});

const trade = (id: string, marketId: string, over: Partial<ValuedTrade> = {}): ValuedTrade => ({
  id,
  marketId,
  side: 'yes',
  quantity: '10',
  price: '0.40',
  costUsd: '4.00',
  status: 'filled',
  payoutUsd: null,
  createdAt: T0,
  ...over,
});

describe('buildPortfolio', () => {
  it('values the account as cash plus open positions at the live midpoint', () => {
    const data: PortfolioData = { trades: [trade('a', 'A')], markets: [market('A')], prices: [], since: T0 };
    const { view, marks } = buildPortfolio(data, { now: NOW, cashUsd: 996, slots: 4 });
    expect(view).toMatchObject({ valueUsd: '1001.50', startUsd: '1000.00', changeUsd: '1.50', openValueUsd: '5.50' });
    expect(marks.get('a')).toEqual({ markPrice: '0.5500', valueUsd: '5.50' });
  });

  it('works out the starting cash from what positions cost and what they paid', () => {
    const data: PortfolioData = {
      trades: [
        trade('a', 'A'),
        trade('b', 'B', { price: '0.50', costUsd: '5.00', status: 'settled', payoutUsd: '10.00', createdAt: plus(10) }),
      ],
      markets: [market('A'), market('B', { resolutionSide: 'yes', resolvedAt: plus(60) })],
      prices: [],
      since: T0,
    };
    // 1000 - 4 - 5 + 10 paid out.
    const { view, marks } = buildPortfolio(data, { now: NOW, cashUsd: 1001, slots: 4 });
    expect(view.startUsd).toBe('1000.00');
    expect(view.valueUsd).toBe('1006.50');
    expect(view.openValueUsd).toBe('5.50');
    expect(marks.has('b')).toBe(false);
  });

  it('draws the line from recorded prices, starting flat and ending at the headline figure', () => {
    const data: PortfolioData = {
      trades: [trade('a', 'A')],
      markets: [market('A')],
      prices: [
        { marketId: 'A', ts: plus(30), yesBid: '0.30', yesAsk: '0.50', lastPrice: null },
        { marketId: 'A', ts: plus(60), yesBid: '0.60', yesAsk: '0.80', lastPrice: null },
      ],
      since: T0,
    };
    const { view } = buildPortfolio(data, { now: NOW, cashUsd: 996, slots: 4 });
    // Slots every 30 minutes. At the start no price is known, so the position is held at cost.
    expect(view.points.map((p) => p.v)).toEqual([1000, 1000, 1003, 1003, 1001.5]);
    expect(view.points[0]!.t).toBe(T0.getTime());
    expect(view.points.at(-1)!.t).toBe(NOW.getTime());
  });

  it('has no line and no change before the first position', () => {
    const { view, marks } = buildPortfolio({ trades: [], markets: [], prices: [], since: null }, { now: NOW, cashUsd: 1000 });
    expect(view).toEqual({
      valueUsd: '1000.00',
      startUsd: '1000.00',
      changeUsd: '0.00',
      openValueUsd: '0.00',
      since: null,
      points: [],
    });
    expect(marks.size).toBe(0);
  });

  it('values a NO position at one minus the YES midpoint', () => {
    const data: PortfolioData = {
      trades: [trade('n', 'A', { side: 'no', price: '0.45', costUsd: '4.50' })],
      markets: [market('A')],
      prices: [],
      since: T0,
    };
    const { marks } = buildPortfolio(data, { now: NOW, cashUsd: 995.5 });
    expect(marks.get('n')).toEqual({ markPrice: '0.4500', valueUsd: '4.50' });
  });
});
