import type { ExtensionCardData, ExtensionThesisRow } from '@thesis/db';
import { describe, expect, it } from 'vitest';
import { excerpt, marketName, rankTheses, toExtCard, toExtMarkets } from '../lib/ext-view';

const NO_RECORD = { resolved: 0, right: 0, brier: null, marketBrier: null };

const thesis = (overrides: Partial<ExtensionThesisRow> = {}): ExtensionThesisRow => ({
  id: 't1',
  side: 'yes',
  probabilityYes: '0.6000',
  entryPrice: '0.5000',
  headline: 'ETF inflows lead',
  body: 'Spot ETF inflows have outpaced new supply for three weeks, and funding is positive.',
  publishedAt: new Date('2026-11-18T03:00:00Z'),
  authorId: 'a1',
  authorKind: 'agent',
  authorName: 'Momentum',
  record: NO_RECORD,
  ...overrides,
});

const card = (theses: ExtensionThesisRow[], quote: Partial<ExtensionCardData['market']> = {}): ExtensionCardData => ({
  market: {
    instrumentSymbol: 'GEMI-BTC2611182200-HI64000',
    title: 'BTC price on Nov 18?',
    contractLabel: '$64,000 or above',
    yesBid: '0.6000',
    yesAsk: '0.7000',
    lastPrice: '0.6500',
    ...quote,
  },
  theses,
});

describe('marketName', () => {
  it('joins the event title and the contract, without the question mark', () => {
    expect(marketName('BTC price on Nov 18?', '$64,000 or above')).toBe('BTC price on Nov 18, $64,000 or above');
    expect(marketName('Recession in 2026?', null)).toBe('Recession in 2026?');
  });
});

describe('toExtMarkets', () => {
  it('sends symbol, a readable title and the keyword groups', () => {
    const asOf = new Date('2026-11-18T03:05:00Z');
    expect(
      toExtMarkets(
        [{ instrumentSymbol: 'GEMI-X', title: 'BTC up?', contractLabel: 'Up', keywords: [['btc']], theses: 2 }],
        asOf,
      ),
    ).toEqual({ asOf: asOf.toISOString(), markets: [{ symbol: 'GEMI-X', title: 'BTC up, Up', keywords: [['btc']] }] });
  });
});

describe('rankTheses', () => {
  const at = (minute: number) => new Date(`2026-11-18T03:${String(minute).padStart(2, '0')}:00Z`);

  it('puts authors with three resolved theses first, best Brier first, then the rest newest first', () => {
    const fresh = thesis({ id: 'fresh', publishedAt: at(9) });
    const old = thesis({ id: 'old', publishedAt: at(1) });
    const good = thesis({ id: 'good', publishedAt: at(2), record: { resolved: 5, right: 4, brier: 0.12, marketBrier: 0.2 } });
    const fair = thesis({ id: 'fair', publishedAt: at(8), record: { resolved: 3, right: 2, brier: 0.2, marketBrier: 0.2 } });
    const early = thesis({ id: 'early', publishedAt: at(5), record: { resolved: 2, right: 2, brier: 0.01, marketBrier: 0.2 } });
    expect(rankTheses([fresh, old, fair, early, good]).map((t) => t.id)).toEqual(['good', 'fair', 'fresh', 'early', 'old']);
  });

  it('falls back to the most recent thesis while nobody qualifies', () => {
    const ranked = rankTheses([thesis({ id: 'a', publishedAt: at(1) }), thesis({ id: 'b', publishedAt: at(4) })]);
    expect(ranked[0]!.id).toBe('b');
  });
});

describe('excerpt', () => {
  it('cuts a long body at a word boundary, at most 180 characters', () => {
    const body = 'word '.repeat(100);
    const text = excerpt(body);
    expect(text.length).toBeLessThanOrEqual(181);
    expect(text.endsWith('word…')).toBe(true);
  });

  it('never shows more than 60% of a short body', () => {
    const body = 'Funding is positive without being euphoric and flows lead.';
    const text = excerpt(body);
    expect(text.length).toBeLessThanOrEqual(Math.floor(body.length * 0.6) + 1);
    expect(body.startsWith(text.slice(0, -1))).toBe(true);
  });

  it('collapses whitespace and handles an empty body', () => {
    expect(excerpt('')).toBe('');
    expect(excerpt('a\n\n  b '.repeat(50))).not.toMatch(/\s{2}|\n/);
  });
});

describe('toExtCard', () => {
  it('builds the card the extension draws', () => {
    const top = thesis({
      id: 'top',
      record: { resolved: 4, right: 3, brier: 0.15, marketBrier: 0.2 },
      publishedAt: new Date('2026-11-18T02:00:00Z'),
    });
    const yes = thesis({ id: 'yes2', headline: 'Halving supply shock', authorKind: 'human', authorName: '@anna', probabilityYes: '0.8000' });
    const no = thesis({ id: 'no1', side: 'no', headline: 'Resistance held twice!', probabilityYes: '0.3000', entryPrice: null });

    const result = toExtCard(card([yes, no, top]));
    expect(result).toMatchObject({
      symbol: 'GEMI-BTC2611182200-HI64000',
      title: 'BTC price on Nov 18, $64,000 or above',
      yesPrice: 0.65,
      top: {
        id: 'top',
        side: 'YES',
        entryPrice: 0.5,
        headline: 'ETF inflows lead',
        author: { name: 'Momentum', kind: 'agent', resolved: 4, correct: 3, brier: 0.15 },
      },
      summary: { thesisCount: 3, yesCount: 2, noCount: 1 },
    });
    expect(result.top!.excerpt.length).toBeLessThan(top.body.length);
    // AI agents average (0.6 + 0.3) / 2 = 45%, people 80%, the market 65%. The top thesis is
    // not repeated; the next most trusted case for each side is.
    expect(result.summary!.text).toBe(
      'AI agents are 20 points below the market. People are 15 points above the market. ' +
        'AI agents are 35 points below people. YES case: Halving supply shock. NO case: Resistance held twice!',
    );
  });

  it('has no top thesis and no summary for a market without theses, and no price for an empty book', () => {
    expect(toExtCard(card([], { yesBid: null, yesAsk: null, lastPrice: null }))).toMatchObject({
      yesPrice: null,
      top: null,
      summary: null,
    });
  });
});
