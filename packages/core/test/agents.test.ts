import { describe, expect, it } from 'vitest';
import {
  AGENT_RULES,
  checkAgentEntry,
  decideFade,
  decideNews,
  findMove,
  type AgentEntry,
  type NewsEstimate,
} from '../src/index';

const entry = (overrides: Partial<AgentEntry> = {}): AgentEntry => ({
  halted: false,
  haltReason: null,
  realizedPnlTodayUsd: 0,
  openExposureUsd: 0,
  tradesToday: 0,
  hasPositionOnMarket: false,
  balanceUsd: 1000,
  costUsd: 10,
  price: 0.5,
  spread: 0.04,
  minutesToExpiry: 600,
  ...overrides,
});
const code = (overrides: Partial<AgentEntry>) => {
  const result = checkAgentEntry(entry(overrides));
  return result.ok ? 'ok' : result.code;
};

describe('checkAgentEntry: each limit at, just under and just over its boundary', () => {
  it('allows an ordinary trade', () => {
    expect(checkAgentEntry(entry())).toEqual({ ok: true });
  });

  it('daily loss stop at $50', () => {
    expect(code({ realizedPnlTodayUsd: -49.99 })).toBe('ok');
    expect(code({ realizedPnlTodayUsd: -50 })).toBe('daily_loss_stop');
    expect(code({ realizedPnlTodayUsd: -50.01 })).toBe('daily_loss_stop');
  });

  it('30 trades a day', () => {
    expect(code({ tradesToday: 29 })).toBe('ok');
    expect(code({ tradesToday: 30 })).toBe('daily_trades');
    expect(code({ tradesToday: 31 })).toBe('daily_trades');
  });

  it('$20 per trade', () => {
    expect(code({ costUsd: 19.99 })).toBe('ok');
    expect(code({ costUsd: 20 })).toBe('ok');
    expect(code({ costUsd: 20.01 })).toBe('per_trade_cap');
  });

  it('$150 of open exposure', () => {
    expect(code({ openExposureUsd: 139.99 })).toBe('ok');
    expect(code({ openExposureUsd: 140 })).toBe('ok');
    expect(code({ openExposureUsd: 140.01 })).toBe('exposure_cap');
  });

  it('one position per contract', () => {
    expect(code({ hasPositionOnMarket: true })).toBe('position_exists');
  });

  it('price band 0.05 to 0.95', () => {
    expect(code({ price: 0.05 })).toBe('ok');
    expect(code({ price: 0.0499 })).toBe('price_band');
    expect(code({ price: 0.95 })).toBe('ok');
    expect(code({ price: 0.9501 })).toBe('price_band');
  });

  it('spread of at most 0.06, and never a one-sided book', () => {
    expect(code({ spread: 0.06 })).toBe('ok');
    expect(code({ spread: 0.0601 })).toBe('spread');
    expect(code({ spread: null })).toBe('spread');
  });

  it('at least 3 minutes to expiry', () => {
    expect(code({ minutesToExpiry: 3 })).toBe('ok');
    expect(code({ minutesToExpiry: 2.99 })).toBe('time_to_expiry');
    expect(code({ minutesToExpiry: null })).toBe('ok');
  });

  it('never spends more than the bankroll left', () => {
    expect(code({ balanceUsd: 10 })).toBe('ok');
    expect(code({ balanceUsd: 9.99 })).toBe('bankroll');
  });

  it('a halted agent does nothing, and says why', () => {
    const result = checkAgentEntry(entry({ halted: true, haltReason: 'daily loss stop' }));
    expect(result).toMatchObject({ ok: false, code: 'halted' });
    expect(result.ok ? '' : result.message).toContain('daily loss stop');
  });

  it('states the limits it enforces', () => {
    expect(AGENT_RULES).toMatchObject({ bankrollUsd: 1000, maxPerTradeUsd: 20, maxOpenExposureUsd: 150, dailyLossStopUsd: 50, maxTradesPerDay: 30 });
  });
});

const estimate = (overrides: Partial<NewsEstimate> = {}): NewsEstimate => ({
  probability_yes: 0.7,
  confidence: 'medium',
  headline: 'h',
  body: 'b',
  evidence: [
    { claim: 'a', url: 'https://a.example/1' },
    { claim: 'b', url: 'https://b.example/2' },
  ],
  no_trade_reason: null,
  ...overrides,
});
const quote = { yesBid: '0.51', yesAsk: '0.55' };

describe('decideNews', () => {
  it('buys YES when its probability beats the YES price by 10 points, and caps the price to keep that edge', () => {
    expect(decideNews(estimate({ probability_yes: 0.7 }), quote)).toEqual({
      decision: 'trade',
      side: 'yes',
      probabilityYes: 0.7,
      limitPrice: '0.60',
      edge: 0.15,
    });
  });

  it('buys NO when its probability is 10 points under what NO implies', () => {
    // NO costs 49 cents. The agent puts NO at 65%, an edge of 16 points; it may pay up to 55.
    expect(decideNews(estimate({ probability_yes: 0.35 }), quote)).toEqual({
      decision: 'trade',
      side: 'no',
      probabilityYes: 0.35,
      limitPrice: '0.55',
      edge: 0.16,
    });
  });

  it('trades at exactly 10 points and not just under', () => {
    expect(decideNews(estimate({ probability_yes: 0.65 }), quote)).toMatchObject({ decision: 'trade', side: 'yes' });
    expect(decideNews(estimate({ probability_yes: 0.649 }), quote)).toMatchObject({ decision: 'skip' });
    expect(decideNews(estimate({ probability_yes: 0.41 }), quote)).toMatchObject({ decision: 'trade', side: 'no' });
    expect(decideNews(estimate({ probability_yes: 0.42 }), quote)).toMatchObject({ decision: 'skip' });
  });

  it('skips on low confidence, fewer than two distinct sources, or the model’s own doubt', () => {
    expect(decideNews(estimate({ confidence: 'low' }), quote)).toMatchObject({ decision: 'skip' });
    expect(decideNews(estimate({ evidence: [{ claim: 'a', url: 'https://a.example/1' }] }), quote)).toMatchObject({ decision: 'skip' });
    expect(
      decideNews(estimate({ evidence: [{ claim: 'a', url: 'https://a.example/1' }, { claim: 'again', url: 'https://a.example/1' }] }), quote),
    ).toMatchObject({ decision: 'skip' });
    expect(decideNews(estimate({ no_trade_reason: 'The rules are ambiguous.' }), quote)).toMatchObject({ decision: 'skip' });
  });

  it('skips a one-sided book', () => {
    expect(decideNews(estimate(), { yesBid: null, yesAsk: '0.55' })).toMatchObject({ decision: 'skip' });
  });
});

describe('findMove', () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const at = (minutesAgo: number, price: number) => ({ t: now - minutesAgo * 60_000, price });

  it('finds a move of 10 points over the last 30 minutes', () => {
    expect(findMove([at(45, 0.4), at(29, 0.42), at(15, 0.5), at(0.5, 0.55)], now)).toMatchObject({
      from: 0.42,
      to: 0.55,
      change: 0.13,
    });
  });

  it('ignores a smaller move', () => {
    expect(findMove([at(29, 0.42), at(0.5, 0.519)], now)).toBeNull();
    expect(findMove([at(29, 0.42), at(0.5, 0.52)], now)).not.toBeNull();
  });

  it('finds a fall as well as a rise', () => {
    expect(findMove([at(28, 0.6), at(1, 0.45)], now)).toMatchObject({ change: -0.15 });
  });

  it('needs history: a market recorded for under 20 minutes shows no move', () => {
    expect(findMove([at(10, 0.3), at(0.5, 0.6)], now)).toBeNull();
    expect(findMove([], now)).toBeNull();
  });

  it('ignores a market whose newest price is stale', () => {
    expect(findMove([at(29, 0.3), at(5, 0.6)], now)).toBeNull();
  });
});

describe('decideFade', () => {
  const move = { from: 0.42, to: 0.62, change: 0.2, fromT: 0, toT: 1 };
  const unexplained = { explained: false, explanation: null, sources: [] };

  it('bets on half of an unexplained rise reversing: NO, with YES put halfway back', () => {
    // YES ran from 42 to 62. The agent puts YES at 52, so NO at 48; NO costs 40.
    expect(decideFade(move, unexplained, { yesBid: '0.60', yesAsk: '0.64' })).toEqual({
      decision: 'trade',
      side: 'no',
      probabilityYes: 0.52,
      limitPrice: '0.45',
      edge: 0.08,
    });
  });

  it('bets YES after an unexplained fall', () => {
    const fall = { from: 0.62, to: 0.42, change: -0.2, fromT: 0, toT: 1 };
    expect(decideFade(fall, unexplained, { yesBid: '0.40', yesAsk: '0.44' })).toMatchObject({
      decision: 'trade',
      side: 'yes',
      probabilityYes: 0.52,
    });
  });

  it('leaves an explained move alone', () => {
    expect(
      decideFade(move, { explained: true, explanation: 'OPEC announced a cut.', sources: [] }, { yesBid: '0.60', yesAsk: '0.64' }),
    ).toMatchObject({ decision: 'skip' });
  });

  it('skips when the price has already come back', () => {
    expect(decideFade(move, unexplained, { yesBid: '0.50', yesAsk: '0.54' })).toMatchObject({ decision: 'skip' });
  });
});
