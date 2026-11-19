import { fromUnits, toUnits } from './money';

/**
 * The limits on a person copying a trade. Each is a pure function, checked on the server
 * immediately before the action it protects, and returns `{ ok: true }` or the reason.
 * Amounts are decimal strings, compared exactly.
 */

export type LimitResult = { ok: true } | { ok: false; code: string; message: string };

const no = (code: string, message: string): LimitResult => ({ ok: false, code, message });
const dollars = (units: bigint) => `$${Number(fromUnits(units)).toFixed(2)}`;

/** The most the app lets anyone tip on one copy, in USDC. The contract's own cap is 5 per thesis. */
export const MAX_TIP_USDC = '0.50';
/** The tips the dialog offers. */
export const TIP_CHOICES_USDC = ['0', '0.10', '0.25', '0.50'] as const;
/** Reject a copy if the price has run more than this above what the author paid. */
export const MAX_SLIPPAGE = '0.05';
/** A copy must close at least this long before the market does. */
export const MIN_MINUTES_TO_COPY = 2;
/** A copy is filled only at a quote recorded within this long. Older means prices are not updating. */
export const MAX_QUOTE_AGE_MS = 120_000;

/** One copy trade may cost at most the user's per-trade cap. */
export function checkPerTradeCap(amountUsd: string, maxPerTradeUsd: string): LimitResult {
  const amount = toUnits(amountUsd);
  if (amount <= 0n) return no('bad_amount', 'Enter an amount above zero.');
  const cap = toUnits(maxPerTradeUsd);
  if (amount > cap) return no('per_trade_cap', `Your limit per copy trade is ${dollars(cap)}.`);
  return { ok: true };
}

/** Copy trades in one UTC day may cost at most the user's daily cap. */
export function checkDailyCopyCap(amountUsd: string, copiedTodayUsd: string, dailyCapUsd: string): LimitResult {
  const cap = toUnits(dailyCapUsd);
  const spent = toUnits(copiedTodayUsd);
  if (spent + toUnits(amountUsd) > cap) {
    const left = cap > spent ? cap - spent : 0n;
    return no(
      'daily_cap',
      `Your daily copy limit is ${dollars(cap)} and you have ${dollars(left)} left. It resets at midnight UTC.`,
    );
  }
  return { ok: true };
}

/** A tip is optional, and at most 0.50 USDC per copy. */
export function checkTipCap(tipUsdc: string): LimitResult {
  const tip = toUnits(tipUsdc);
  if (tip < 0n) return no('bad_tip', 'A tip cannot be negative.');
  if (tip > toUnits(MAX_TIP_USDC)) return no('tip_cap', `The most you can tip on one copy is ${MAX_TIP_USDC} USDC.`);
  return { ok: true };
}

/** A copier must not pay much more than the author did, or they are not copying the same trade. */
export function checkSlippage(ask: string, entryPrice: string): LimitResult {
  if (toUnits(ask) > toUnits(entryPrice) + toUnits(MAX_SLIPPAGE)) {
    return no('price_moved', `The price has moved to ${ask}, more than 5 cents above the author's entry of ${entryPrice}.`);
  }
  return { ok: true };
}

/** The defaults a new user starts with, and the range each limit can be set within. */
export const LIMIT_BOUNDS = {
  maxPerTradeUsd: { min: 1, max: 10, fallback: 10 },
  dailyCopyCapUsd: { min: 1, max: 100, fallback: 25 },
} as const;

export type LimitName = keyof typeof LIMIT_BOUNDS;

/** Whether a value a user asked for is a whole number of cents inside the allowed range. */
export function checkLimitValue(name: LimitName, value: number): LimitResult {
  const { min, max } = LIMIT_BOUNDS[name];
  const label = name === 'maxPerTradeUsd' ? 'The most per copy trade' : 'The daily copy cap';
  if (!Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    return no('bad_limit', `${label} must be an amount in dollars and cents.`);
  }
  if (value < min || value > max) {
    return no('bad_limit', `${label} must be between $${min} and $${max}.`);
  }
  return { ok: true };
}

/** Nobody copies or tips their own thesis: it would inflate their own totals. */
export function checkNotOwnThesis(userId: string, authorUserId: string | null): LimitResult {
  if (authorUserId !== null && authorUserId === userId) return no('own_thesis', 'You cannot copy or tip your own thesis.');
  return { ok: true };
}
