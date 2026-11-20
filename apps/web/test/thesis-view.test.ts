import { describe, expect, it } from 'vitest';
import {
  claimTally,
  claimTallyText,
  marketTitle,
  moveSinceEntry,
  positionTrend,
  screenStatus,
  shortHash,
  type AuditClaimView,
  type AuditSummary,
} from '../lib/thesis-view';

const claim = (status: AuditClaimView['status']): AuditClaimView => ({ text: 'x', status, sourceUrl: null, note: null });
const audit = (over: Partial<AuditSummary> = {}): AuditSummary => ({
  verdict: 'pass',
  checked: 0,
  problems: 0,
  screenOnly: false,
  insideInfo: false,
  ...over,
});

describe('claimTally', () => {
  it('counts claims by what the check found', () => {
    const tally = claimTally([
      claim('supported'),
      claim('unverifiable'),
      claim('contradicted'),
      claim('unsupported'),
      claim('unverifiable'),
    ]);
    expect(tally).toEqual({ total: 5, supported: 1, problems: 2, unchecked: 2 });
  });
});

describe('claimTallyText', () => {
  it('names each kind that is present, problems first', () => {
    expect(claimTallyText(claimTally([claim('supported'), claim('unverifiable'), claim('unverifiable')]))).toBe(
      '3 claims: 1 supported, 2 not checked',
    );
    expect(claimTallyText(claimTally([claim('contradicted'), claim('supported')]))).toBe('2 claims: 1 flagged, 1 supported');
  });

  it('reads naturally for one claim and for none', () => {
    expect(claimTallyText(claimTally([claim('supported')]))).toBe('1 claim: 1 supported');
    expect(claimTallyText(claimTally([]))).toBe('No checkable claims');
  });
});

describe('screenStatus', () => {
  it('is clear when the audit ran and found no inside information', () => {
    expect(screenStatus(audit())).toBe('clear');
    expect(screenStatus(audit({ screenOnly: true }))).toBe('clear');
  });

  it('is found when the screen flagged inside information', () => {
    expect(screenStatus(audit({ insideInfo: true, verdict: 'blocked' }))).toBe('found');
  });

  it('is pending before any audit', () => {
    expect(screenStatus(null)).toBe('pending');
  });
});

describe('marketTitle', () => {
  it('drops the question mark before a contract label', () => {
    expect(marketTitle({ title: 'Best AI at the end of 2026?', contractLabel: 'Gemini' })).toBe(
      'Best AI at the end of 2026, Gemini',
    );
  });

  it('keeps a title with no contract label as it is', () => {
    expect(marketTitle({ title: 'Will BTC close above $100K?', contractLabel: null })).toBe('Will BTC close above $100K?');
  });
});

describe('moveSinceEntry and positionTrend', () => {
  const base = { status: 'published' as const, outcome: null, entryPrice: '0.80', currentPrice: '0.84' };

  it('is the move in whole cents since the author bought', () => {
    expect(moveSinceEntry(base)).toBe(4);
    expect(moveSinceEntry({ ...base, currentPrice: '0.7650' })).toBe(-4);
    expect(moveSinceEntry({ ...base, currentPrice: null })).toBeNull();
  });

  it('follows the price while open and the outcome once resolved', () => {
    expect(positionTrend(base)).toBe('up');
    expect(positionTrend({ ...base, currentPrice: '0.80' })).toBe('flat');
    expect(positionTrend({ ...base, currentPrice: '0.70' })).toBe('down');
    expect(positionTrend({ ...base, status: 'resolved', outcome: 'wrong' })).toBe('down');
    expect(positionTrend({ ...base, status: 'resolved', outcome: 'void' })).toBe('flat');
  });
});

describe('shortHash', () => {
  it('keeps the start and the end of a long hash', () => {
    expect(shortHash('0xabde8f969543a7a8842aa57745c4e8c5461b2efc715cee5fbcdf026433839403')).toBe('0xabde…9403');
    expect(shortHash('0x1234')).toBe('0x1234');
  });
});
