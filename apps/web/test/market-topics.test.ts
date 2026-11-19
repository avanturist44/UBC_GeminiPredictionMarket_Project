import { describe, expect, it } from 'vitest';
import { marketTopics, marketsInTopic, type MarketView } from '../lib/market-view';

const market = (symbol: string, category: string | null): MarketView => ({
  symbol,
  eventTicker: symbol,
  title: symbol,
  contractLabel: null,
  category,
  expiryAt: null,
  opensAt: null,
  marketState: 'open',
  strike: null,
  yesBid: null,
  yesAsk: null,
  lastPrice: null,
  yesMid: null,
  resolutionSide: null,
  thesesYes: 0,
  thesesNo: 0,
  updatedAt: '2026-11-19T00:00:00.000Z',
});

const markets = [
  market('BTC-1', 'Crypto'),
  market('ETH-1', 'Crypto'),
  market('BRENT', 'Commodities'),
  market('NYC', 'Weather'),
  market('AI', 'Tech'),
  market('GOLD', 'Commodities'),
  market('BTC-2', 'Crypto'),
  market('ODD', null),
  market('ODD-2', '  '),
];

describe('marketTopics', () => {
  it('counts each topic, largest first and then by name, with Other last', () => {
    expect(marketTopics(markets)).toEqual([
      { id: 'crypto', label: 'Crypto', count: 3 },
      { id: 'commodities', label: 'Commodities', count: 2 },
      { id: 'tech', label: 'Tech', count: 1 },
      { id: 'weather', label: 'Weather', count: 1 },
      { id: 'other', label: 'Other', count: 2 },
    ]);
  });

  it('makes an address-safe id from a category with spaces and symbols', () => {
    expect(marketTopics([market('X', 'Science & Tech')])).toEqual([{ id: 'science-tech', label: 'Science & Tech', count: 1 }]);
  });

  it('has no topics without markets', () => {
    expect(marketTopics([])).toEqual([]);
  });
});

describe('marketsInTopic', () => {
  it('keeps the markets of one topic, in their order', () => {
    expect(marketsInTopic(markets, 'crypto').map((m) => m.symbol)).toEqual(['BTC-1', 'ETH-1', 'BTC-2']);
    expect(marketsInTopic(markets, 'other').map((m) => m.symbol)).toEqual(['ODD', 'ODD-2']);
  });

  it('keeps every market for all, and none for a topic that is not there', () => {
    expect(marketsInTopic(markets, 'all')).toHaveLength(markets.length);
    expect(marketsInTopic(markets, 'politics')).toEqual([]);
  });
});
