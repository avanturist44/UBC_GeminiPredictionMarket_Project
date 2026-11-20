import { describe, expect, it } from 'vitest';
// match.js is a plain browser script: loading it puts TMMatch on globalThis.
import '../match.js';

interface Market {
  symbol: string;
  keywords: string[][];
}
const { scoreMarket, bestMatch } = (globalThis as unknown as {
  TMMatch: {
    scoreMarket: (text: string, keywords: string[][]) => number;
    bestMatch: (text: string, markets: Market[]) => Market | null;
  };
}).TMMatch;

const BTC: Market = { symbol: 'BTC', keywords: [['bitcoin'], ['btc'], ['$btc']] };
const FED: Market = { symbol: 'FED', keywords: [['fed', 'rate'], ['fomc'], ['powell', 'cut']] };

describe('scoreMarket', () => {
  it('matches each keyword group from the build plan', () => {
    expect(scoreMarket('Bitcoin is ripping', BTC.keywords)).toBe(1);
    expect(scoreMarket('long BTC into the close', BTC.keywords)).toBe(1);
    expect(scoreMarket('$BTC to the moon', BTC.keywords)).toBe(1);
    expect(scoreMarket('The Fed will hold the rate', FED.keywords)).toBe(2);
    expect(scoreMarket('FOMC minutes are out', FED.keywords)).toBe(1);
    expect(scoreMarket('Powell hints at a cut', FED.keywords)).toBe(2);
  });

  it('ignores case', () => {
    expect(scoreMarket('BITCOIN', BTC.keywords)).toBe(1);
    expect(scoreMarket('fOmC', FED.keywords)).toBe(1);
  });

  it('needs every term of a group, as whole words', () => {
    expect(scoreMarket('The Fed spoke today', FED.keywords)).toBe(0);
    expect(scoreMarket('federal holiday', FED.keywords)).toBe(0);
    expect(scoreMarket('bitcoiner meetup', BTC.keywords)).toBe(0);
  });

  it('accepts a plural', () => {
    expect(scoreMarket('Rate cuts are coming, says Powell', FED.keywords)).toBe(2);
  });

  it('does not match unrelated posts', () => {
    expect(scoreMarket('Great game last night, what a finish', BTC.keywords)).toBe(0);
    expect(scoreMarket('Great game last night, what a finish', FED.keywords)).toBe(0);
  });
});

describe('bestMatch', () => {
  it('picks the market with the most matched terms', () => {
    expect(bestMatch('Fed rate cut will pump bitcoin', [BTC, FED])?.symbol).toBe('FED');
  });

  it('gives a tie to the first market listed', () => {
    const otherBtc: Market = { symbol: 'BTC-2', keywords: [['bitcoin']] };
    expect(bestMatch('bitcoin', [BTC, otherBtc])?.symbol).toBe('BTC');
    expect(bestMatch('bitcoin', [otherBtc, BTC])?.symbol).toBe('BTC-2');
  });

  it('returns null when nothing matches', () => {
    expect(bestMatch('nothing here', [BTC, FED])).toBeNull();
  });
});
