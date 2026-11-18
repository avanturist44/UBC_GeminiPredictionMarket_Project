import { describe, expect, it } from 'vitest';
import { evaluateNews, newsMarketEligible, NEWS_INTERVAL_MS, type NewsResearchResult } from '../src/news';

const now = Date.parse('2026-11-18T12:00:00Z');
export function research(at = now): NewsResearchResult {
  return { provider: 'fixture', model: 'fixture-model', searchedAtMs: at,
    sources: [{ url: 'https://www.reuters.com/markets/example', title: 'Public report' },
      { url: 'https://www.bls.gov/news.release/example.htm', title: 'Official release' }],
    forecast: { probability_yes: 0.75, confidence: 'medium', headline: 'Evidence-based forecast', body: 'Research fixture, not a live forecast.',
      no_trade_reason: null, evidence: [{ claim: 'Public report', url: 'https://www.reuters.com/markets/example' },
        { claim: 'Official release', url: 'https://www.bls.gov/news.release/example.htm' }] } };
}
const input = () => ({ nowMs: now, expiryMs: now + 3600_000, marketState: 'open',
  quote: { observedAtMs: now, bid: .48, ask: .5, bidSize: 9, askSize: 7 }, research: research() });
const forecast = (result: NewsResearchResult) => result.forecast as Record<string, unknown>;

describe('news decision policy', () => {
  it('derives YES/NO side and executable price/size in code', () => {
    expect(evaluateNews(input())).toMatchObject({ decision: 'candidate', side: 'yes', entryPrice: .5, availableQuantity: 7 });
    const value = input(); forecast(value.research).probability_yes = .25;
    expect(evaluateNews(value)).toMatchObject({ decision: 'candidate', side: 'no', entryPrice: .52, availableQuantity: 9 });
  });
  it('requires ten cents of edge at the boundary', () => {
    const value = input(); forecast(value.research).probability_yes = .6;
    expect(evaluateNews(value).decision).toBe('candidate');
    forecast(value.research).probability_yes = .5999;
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'edge below ten cents' });
  });
  it('rejects malformed output and model-supplied execution fields', () => {
    for (const change of [{ probability_yes: 1.1 }, { probability_yes: '0.9' }, { side: 'yes' }, { quantity: 1000 }, { confidence: 'certain' }]) {
      const value = input(); Object.assign(forecast(value.research), change);
      expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'invalid research output' });
    }
  });
  it('honors low confidence and an explicit research abstention', () => {
    const value = input(); forecast(value.research).confidence = 'low';
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'low research confidence' });
    forecast(value.research).no_trade_reason = 'Rules are ambiguous';
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'research abstained: Rules are ambiguous' });
  });
  it('requires two retrieved source domains and rejects invented citations', () => {
    const value = input(); value.research.sources.pop();
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'citation missing from retrieved sources' });
    const same = input();
    forecast(same.research).evidence = [{ claim: 'One', url: 'https://www.reuters.com/markets/example' },
      { claim: 'Two', url: 'https://reuters.com/markets/other' }];
    same.research.sources.push({ url: 'https://reuters.com/markets/other', title: 'Same domain' });
    expect(evaluateNews(same)).toMatchObject({ decision: 'skip', reason: 'fewer than two source domains' });
    const empty = input(); forecast(empty.research).evidence = [];
    expect(evaluateNews(empty).decision).toBe('skip');
  });
  it('checks research and book freshness on both sides of each boundary', () => {
    const value = input(); value.research.searchedAtMs = now - NEWS_INTERVAL_MS;
    expect(evaluateNews(value).decision).toBe('candidate');
    value.research.searchedAtMs--;
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'stale research' });
    value.research.searchedAtMs = now + 1;
    expect(evaluateNews(value).decision).toBe('skip');
    const book = input(); book.quote.observedAtMs = now - 10_000;
    expect(evaluateNews(book).decision).toBe('candidate');
    book.quote.observedAtMs--;
    expect(evaluateNews(book)).toMatchObject({ decision: 'skip', reason: 'missing or stale book' });
  });
  it('rejects wide spreads, empty books, closed markets, and imminent expiry', () => {
    const value = input(); value.quote.bid = .43;
    expect(evaluateNews(value)).toMatchObject({ decision: 'skip', reason: 'spread too wide' });
    value.quote.bid = .48; value.quote.askSize = 0;
    expect(evaluateNews(value).decision).toBe('skip');
    value.quote.askSize = 7; value.marketState = 'post_only';
    expect(evaluateNews(value).decision).toBe('skip');
    value.marketState = 'open'; value.expiryMs = now + 179_999;
    expect(evaluateNews(value).decision).toBe('skip');
    value.expiryMs++;
    expect(evaluateNews(value).decision).toBe('candidate');
  });
});

it('limits news markets to tracked non-crypto and daily BTC/ETH contracts', () => {
  const market = { eventTicker: 'BTC2611182200', category: 'Crypto', tracked: true, status: 'active',
    marketState: 'open', expiryAt: new Date(now + 3600_000) };
  expect(newsMarketEligible(market, now)).toBe(true);
  expect(newsMarketEligible({ ...market, eventTicker: 'BTC15M2611181215' }, now)).toBe(false);
  expect(newsMarketEligible({ ...market, eventTicker: 'SOL05M2611181215' }, now)).toBe(false);
  expect(newsMarketEligible({ ...market, eventTicker: 'BTC15M2611181215', category: 'Other' }, now)).toBe(false);
  expect(newsMarketEligible({ ...market, eventTicker: 'BRENT2611182200', category: 'Commodities' }, now)).toBe(true);
  expect(newsMarketEligible({ ...market, tracked: false }, now)).toBe(false);
  expect(newsMarketEligible({ ...market, marketState: 'closed' }, now)).toBe(false);
});
