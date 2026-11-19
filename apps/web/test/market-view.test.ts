import type { MarketDetail, MarketRow } from '@thesis/db';
import { describe, expect, it } from 'vitest';
import { GEMINI_EVENT_URL, toMarketDetailView, toMarketView } from '../lib/market-mapping';
import { sortMarkets } from '../lib/market-view';

const row = (overrides: Partial<MarketRow> = {}): MarketRow => ({
  instrumentSymbol: 'GEMI-BTC15M2611180315-UP',
  eventTicker: 'BTC15M2611180315',
  contractTicker: 'UP',
  title: 'BTC price today at 10:15pm EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: new Date('2026-11-18T03:15:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '64931.38',
  yesBid: '0.8900',
  yesAsk: '0.9500',
  lastPrice: '0.8300',
  resolutionSide: null,
  resolvedAt: null,
  updatedAt: new Date('2026-11-18T03:05:00Z'),
  thesesYes: 2,
  thesesNo: 1,
  ...overrides,
});

describe('toMarketView', () => {
  it('maps a market row to what the pages show', () => {
    expect(toMarketView(row())).toEqual({
      symbol: 'GEMI-BTC15M2611180315-UP',
      eventTicker: 'BTC15M2611180315',
      title: 'BTC price today at 10:15pm EST',
      contractLabel: 'Up',
      category: 'Crypto',
      expiryAt: '2026-11-18T03:15:00.000Z',
      marketState: 'open',
      strike: '64931.38',
      yesBid: '0.8900',
      yesAsk: '0.9500',
      lastPrice: '0.8300',
      yesMid: 0.92,
      resolutionSide: null,
      thesesYes: 2,
      thesesNo: 1,
      updatedAt: '2026-11-18T03:05:00.000Z',
    });
  });

  it('has no midpoint when a side of the book is empty', () => {
    expect(toMarketView(row({ yesBid: null }))).toMatchObject({ yesMid: null });
  });
});

describe('sortMarkets', () => {
  const a = toMarketView(row({ instrumentSymbol: 'A', expiryAt: new Date('2026-11-18T03:15:00Z'), thesesYes: 0, thesesNo: 1 }));
  const b = toMarketView(row({ instrumentSymbol: 'B', expiryAt: new Date('2026-11-19T22:00:00Z'), thesesYes: 3, thesesNo: 2 }));
  const c = toMarketView(row({ instrumentSymbol: 'C', expiryAt: null, thesesYes: 0, thesesNo: 0 }));
  const d = toMarketView(row({ instrumentSymbol: 'D', expiryAt: new Date('2026-11-18T03:30:00Z'), thesesYes: 1, thesesNo: 0 }));

  it('sorts by expiry, soonest first, with no end date last', () => {
    expect(sortMarkets([c, b, d, a], 'expiry').map((m) => m.symbol)).toEqual(['A', 'D', 'B', 'C']);
  });

  it('sorts by thesis count, most first, then by expiry', () => {
    expect(sortMarkets([c, a, d, b], 'theses').map((m) => m.symbol)).toEqual(['B', 'A', 'D', 'C']);
  });

  it('does not change the list it was given', () => {
    const list = [c, b, a];
    sortMarkets(list, 'expiry');
    expect(list.map((m) => m.symbol)).toEqual(['C', 'B', 'A']);
  });
});

describe('toMarketDetailView', () => {
  it('excludes verification accounts from forecast averages while retaining public chart markers', () => {
    const input: MarketDetail = { market: row(), points: [], theses: [{id:'verification',headline:'Verification only',side:'yes',probabilityYes:'0.99',publishedAt:null,authorKind:'human',authorName:'Verification',isTest:true}] };
    const result=toMarketDetailView(input,new Date());
    expect(result.disagreement.human).toEqual({average:null,count:0});expect(result.theses).toHaveLength(1);
  });
  const t = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 18, 3, minute, second));
  const detail: MarketDetail = {
    market: row(),
    points: [
      { ts: t(0), yesBid: '0.4000', yesAsk: '0.5000', lastPrice: null },
      // One side only: no midpoint to plot.
      { ts: t(1), yesBid: null, yesAsk: '0.9700', lastPrice: null },
      // The book emptied for an instant while quotes were replaced. Not a move to 46 cents.
      { ts: t(2), yesBid: null, yesAsk: null, lastPrice: '0.4600' },
      { ts: t(4), yesBid: '0.6000', yesAsk: '0.7000', lastPrice: '0.4600' },
    ],
    theses: [
      {
        id: 't1',
        headline: 'Momentum says up',
        side: 'yes',
        probabilityYes: '0.9000',
        publishedAt: t(3),
        authorKind: 'agent',
        authorName: 'Momentum',
      },
      {
        id: 't2',
        headline: 'Too far, too fast',
        side: 'no',
        probabilityYes: '0.3000',
        publishedAt: t(3, 30),
        authorKind: 'human',
        authorName: 'Sam',
      },
      {
        id: 't3',
        headline: 'Fade it',
        side: 'no',
        probabilityYes: '0.5000',
        publishedAt: t(4),
        authorKind: 'human',
        authorName: 'Ana',
      },
    ],
  };
  const view = toMarketDetailView(detail, new Date('2026-11-18T03:05:00Z'));

  it('plots the midpoints and skips points without both sides of the book', () => {
    expect(view.series).toBe('midpoint');
    expect(view.points).toEqual([
      { t: t(0).getTime(), price: 0.45 },
      { t: t(4).getTime(), price: 0.65 },
    ]);
  });

  it('plots last trades for a market whose book never had both sides', () => {
    const oneSided = toMarketDetailView(
      {
        ...detail,
        points: [
          { ts: t(0), yesBid: null, yesAsk: '0.1100', lastPrice: '0.0400' },
          { ts: t(1), yesBid: null, yesAsk: '0.1100', lastPrice: null },
          { ts: t(2), yesBid: null, yesAsk: '0.0900', lastPrice: '0.0500' },
        ],
      },
      new Date(),
    );
    expect(oneSided.series).toBe('lastTrade');
    expect(oneSided.points).toEqual([
      { t: t(0).getTime(), price: 0.04 },
      { t: t(2).getTime(), price: 0.05 },
    ]);
  });

  it('keeps the trade history of a one-sided market that had both sides for a moment', () => {
    const mostlyOneSided = toMarketDetailView(
      {
        ...detail,
        points: [
          { ts: t(0), yesBid: null, yesAsk: '0.1100', lastPrice: '0.0400' },
          { ts: t(1), yesBid: null, yesAsk: '0.1100', lastPrice: '0.0400' },
          // A bid appeared once. It must not replace hours of trades with a single point.
          { ts: t(2), yesBid: '0.0300', yesAsk: '0.1100', lastPrice: '0.0400' },
          { ts: t(3), yesBid: null, yesAsk: '0.0900', lastPrice: '0.0500' },
        ],
      },
      new Date(),
    );
    expect(mostlyOneSided.series).toBe('lastTrade');
    expect(mostlyOneSided.points.map((p) => p.price)).toEqual([0.04, 0.04, 0.04, 0.05]);
  });

  it('places each thesis at its publish time, on the price the market had then', () => {
    expect(view.theses.map((m) => [m.id, m.t, m.price])).toEqual([
      ['t1', t(3).getTime(), 0.45],
      ['t2', t(3, 30).getTime(), 0.45],
      ['t3', t(4).getTime(), 0.65],
    ]);
    expect(view.theses[0]).toMatchObject({
      headline: 'Momentum says up',
      side: 'yes',
      probabilityYes: 0.9,
      authorKind: 'agent',
      authorName: 'Momentum',
    });
  });

  it('averages the AI and the human probabilities for the disagreement summary', () => {
    expect(view.disagreement).toEqual({
      marketPrice: 0.92,
      ai: { average: 0.9, count: 1 },
      human: { average: 0.4, count: 2 },
    });
  });

  it('reports no average for a group with no theses', () => {
    const empty = toMarketDetailView({ ...detail, theses: [] }, new Date());
    expect(empty.disagreement).toEqual({
      marketPrice: 0.92,
      ai: { average: null, count: 0 },
      human: { average: null, count: 0 },
    });
  });

  it('links to the event on Gemini’s site', () => {
    expect(view.geminiUrl).toBe('https://www.gemini.com/predictions/BTC15M2611180315');
    expect(GEMINI_EVENT_URL).toBe('https://www.gemini.com/predictions/');
  });

  it('carries when it was read', () => {
    expect(view.asOf).toBe('2026-11-18T03:05:00.000Z');
  });
});
