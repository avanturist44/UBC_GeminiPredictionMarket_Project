import { describe, expect, it } from 'vitest';
import { usdcUnitsToText } from '../lib/format';
import { disagreementLines } from '../lib/market-view';
import {
  activityText,
  rankAuthors,
  signedUsd,
  tipStatusText,
  usdc,
  type ActivityItemView,
  type LeaderboardRow,
} from '../lib/record-view';

const author = (
  name: string,
  record: { resolved: number; right: number; brier: number | null },
  profitUsd: string,
): LeaderboardRow => ({
  id: name,
  name,
  kind: 'agent',
  record: { ...record, marketBrier: null },
  profitUsd,
  theses: record.resolved,
});

describe('rankAuthors', () => {
  const sharp = author('Sharp', { resolved: 10, right: 8, brier: 0.12 }, '4.0000');
  const lucky = author('Lucky', { resolved: 2, right: 2, brier: 0.2 }, '30.0000');
  const coin = author('Coin', { resolved: 10, right: 5, brier: 0.25 }, '-6.0000');
  const fresh = author('Fresh', { resolved: 0, right: 0, brier: null }, '0.0000');
  const all = [fresh, coin, lucky, sharp];

  it('puts the lowest Brier score first, and authors with nothing resolved last', () => {
    expect(rankAuthors(all, 'brier').map((a) => a.name)).toEqual(['Sharp', 'Lucky', 'Coin', 'Fresh']);
  });

  it('puts the largest profit first', () => {
    expect(rankAuthors(all, 'profit').map((a) => a.name)).toEqual(['Lucky', 'Sharp', 'Fresh', 'Coin']);
  });

  it('breaks a tie by the larger sample, then by name', () => {
    const a = author('Beta', { resolved: 3, right: 2, brier: 0.2 }, '1.0000');
    const b = author('Alpha', { resolved: 3, right: 2, brier: 0.2 }, '1.0000');
    const c = author('Gamma', { resolved: 9, right: 6, brier: 0.2 }, '1.0000');
    expect(rankAuthors([a, b, c], 'brier').map((x) => x.name)).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect(rankAuthors([a, b, c], 'profit').map((x) => x.name)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('leaves the list it was given untouched', () => {
    rankAuthors(all, 'profit');
    expect(all.map((a) => a.name)).toEqual(['Fresh', 'Coin', 'Lucky', 'Sharp']);
  });
});

describe('activityText', () => {
  const item = (overrides: Partial<ActivityItemView>): ActivityItemView => ({
    tipId: 't',
    status: 'paid',
    amountUsdc: '0.600000',
    settleTx: null,
    thesisId: 'th',
    outcome: 'right',
    authorName: 'Momentum',
    marketTitle: 'BTC 15-minute',
    at: '2026-11-19T03:30:00.000Z',
    ...overrides,
  });

  it('says a right author was paid from escrow', () => {
    expect(activityText(item({}))).toBe('Momentum was right on BTC 15-minute: 0.60 USDC paid from escrow');
  });

  it('says a wrong author’s tip went back', () => {
    expect(activityText(item({ status: 'refunded', outcome: 'wrong', amountUsdc: '0.25' }))).toBe(
      'Momentum was wrong on BTC 15-minute: 0.25 USDC returned to the tipper',
    );
  });

  it('does not call anyone wrong when a market was voided', () => {
    expect(activityText(item({ status: 'refunded', outcome: 'void' }))).toBe(
      'BTC 15-minute had no result: 0.60 USDC returned to the tipper',
    );
  });
});

describe('small formatters', () => {
  it('shows USDC to the cent', () => {
    expect(usdc('0.250000')).toBe('0.25');
    expect(usdc('2')).toBe('2.00');
  });

  it('shows a wallet balance cut to the cent, never rounded up', () => {
    expect(usdcUnitsToText(0n)).toBe('0.00');
    expect(usdcUnitsToText(1_750_000n)).toBe('1.75');
    expect(usdcUnitsToText(1_999_999n)).toBe('1.99');
    expect(usdcUnitsToText(86_040_000n)).toBe('86.04');
    expect(usdcUnitsToText(9_999n)).toBe('0.00');
  });

  it('signs profit and loss, and leaves zero unsigned', () => {
    expect(signedUsd(3.04)).toBe('+$3.04');
    expect(signedUsd(-4.96)).toBe('-$4.96');
    expect(signedUsd(0)).toBe('$0.00');
    expect(signedUsd(-0.001)).toBe('$0.00');
  });

  it('has words for every tip status', () => {
    for (const status of ['pending', 'escrowed', 'paid', 'refunded', 'failed'] as const) {
      expect(tipStatusText(status).length).toBeGreaterThan(5);
    }
  });
});

describe('disagreementLines', () => {
  const group = (average: number | null, count = average === null ? 0 : 2) => ({ average, count });

  it('gives each group’s gap to the market in points, and the gap between the groups', () => {
    expect(disagreementLines({ marketPrice: 0.62, ai: group(0.71), human: group(0.55) })).toEqual([
      'AI agents are 9 points above the market.',
      'People are 7 points below the market.',
      'AI agents are 16 points above people.',
    ]);
  });

  it('leaves out a group with no theses', () => {
    expect(disagreementLines({ marketPrice: 0.5, ai: group(null), human: group(0.51) })).toEqual([
      'People are 1 point above the market.',
    ]);
    expect(disagreementLines({ marketPrice: 0.5, ai: group(null), human: group(null) })).toEqual([]);
  });

  it('says so when they agree', () => {
    expect(disagreementLines({ marketPrice: 0.5, ai: group(0.5), human: group(0.5) })).toEqual([
      'AI agents agree with the market.',
      'People agree with the market.',
      'AI agents and people agree with each other.',
    ]);
  });

  it('still compares the groups when the market has no price', () => {
    expect(disagreementLines({ marketPrice: null, ai: group(0.4), human: group(0.6) })).toEqual([
      'AI agents are 20 points below people.',
    ]);
  });
});
