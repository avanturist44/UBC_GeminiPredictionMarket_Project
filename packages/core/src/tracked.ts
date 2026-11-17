import type { GeminiContract, GeminiEvent } from './gemini/schemas';
import { rollingEventTickers, type RollingSpec } from './gemini/tickers';

/**
 * Which Gemini contracts the app tracks. The recorder turns these rules into `markets`
 * rows; everything else (agents, feeds, the extension) reads the rows.
 *
 * The list below is a Phase 0 default built from what Gemini listed on 2026-11-17.
 * Choosing the 8 to 12 tracked markets is a team decision: edit DEFAULT_TRACKED_RULES.
 */

export type ContractPick =
  /** Every contract in the event. Use for single-contract events. */
  | { kind: 'all' }
  /** Named contract tickers, for example ["HI65000"]. */
  | { kind: 'tickers'; tickers: string[] }
  /** The `count` open contracts whose YES price is closest to 50 cents when first seen. */
  | { kind: 'nearestMoney'; count: number };

export interface TrackedRule {
  key: string;
  event: { kind: 'fixed'; ticker: string } | ({ kind: 'rolling' } & RollingSpec);
  pick: ContractPick;
  /**
   * Keyword groups for the Chrome extension. A post matches when every term in at
   * least one group appears in it, ignoring case.
   */
  keywords: string[][];
}

const DAY = 1440;

export const DEFAULT_TRACKED_RULES: TrackedRule[] = [
  // Short contracts: they resolve every 15 minutes, so a payout can be shown live.
  {
    key: 'btc-15m',
    event: { kind: 'rolling', prefix: 'BTC15M', periodMinutes: 15, offsetMinutes: 0, count: 2 },
    pick: { kind: 'all' },
    keywords: [['bitcoin'], ['btc'], ['$btc']],
  },
  {
    key: 'eth-15m',
    event: { kind: 'rolling', prefix: 'ETH15M', periodMinutes: 15, offsetMinutes: 0, count: 2 },
    pick: { kind: 'all' },
    keywords: [['ethereum'], ['$eth'], ['eth', 'price']],
  },
  // Daily crypto contracts, expiring 22:00 UTC.
  {
    key: 'btc-daily',
    event: { kind: 'rolling', prefix: 'BTC', periodMinutes: DAY, offsetMinutes: 22 * 60, count: 1 },
    pick: { kind: 'nearestMoney', count: 1 },
    keywords: [['bitcoin'], ['btc'], ['$btc']],
  },
  {
    key: 'eth-daily',
    event: { kind: 'rolling', prefix: 'ETH', periodMinutes: DAY, offsetMinutes: 22 * 60, count: 1 },
    pick: { kind: 'nearestMoney', count: 1 },
    keywords: [['ethereum'], ['$eth'], ['eth', 'price']],
  },
  // Non-crypto markets that resolve every day this week.
  {
    key: 'brent-daily',
    event: { kind: 'rolling', prefix: 'BRENT', periodMinutes: DAY, offsetMinutes: 22 * 60, count: 1 },
    pick: { kind: 'nearestMoney', count: 1 },
    keywords: [['brent'], ['crude', 'oil'], ['oil', 'price']],
  },
  {
    key: 'gold-daily',
    event: { kind: 'rolling', prefix: 'XAU', periodMinutes: DAY, offsetMinutes: 22 * 60, count: 1 },
    pick: { kind: 'nearestMoney', count: 1 },
    keywords: [['gold', 'price'], ['xau'], ['gold', 'ounce']],
  },
  {
    key: 'nyc-high-temp',
    event: {
      kind: 'rolling',
      prefix: 'WXHIGH-NYC-',
      periodMinutes: DAY,
      offsetMinutes: 4 * 60 + 59,
      count: 1,
    },
    pick: { kind: 'nearestMoney', count: 1 },
    keywords: [['nyc', 'temperature'], ['new york', 'weather'], ['nyc', 'forecast']],
  },
  // Longer markets: they do not resolve this week, but carry theses worth reading.
  {
    key: 'recession-2026',
    event: { kind: 'fixed', ticker: 'RECESSION26' },
    pick: { kind: 'all' },
    keywords: [['recession'], ['gdp', 'contraction']],
  },
  {
    key: 'crypto-market-structure',
    event: { kind: 'fixed', ticker: 'CRYPTOSTRUCT26' },
    pick: { kind: 'tickers', tickers: ['2027'] },
    keywords: [['market structure', 'crypto'], ['clarity act'], ['crypto', 'legislation']],
  },
  {
    key: 'best-ai-2026',
    event: { kind: 'fixed', ticker: 'BESTAI26' },
    pick: { kind: 'tickers', tickers: ['GEMINI'] },
    keywords: [['best ai'], ['lmarena'], ['top', 'ai model']],
  },
];

export function resolveEventTickers(rule: TrackedRule, now: Date): string[] {
  return rule.event.kind === 'fixed' ? [rule.event.ticker] : rollingEventTickers(rule.event, now);
}

export interface YesQuote {
  bid: string | null;
  ask: string | null;
  last: string | null;
}

/** The YES-side quote of a contract. Missing sides of the book are null. */
export function yesQuote(contract: GeminiContract): YesQuote {
  return {
    bid: contract.prices?.bestBid ?? null,
    ask: contract.prices?.bestAsk ?? null,
    last: contract.prices?.lastTradePrice ?? null,
  };
}

/** Distance of the YES price from 50 cents, or null when there is no price at all. */
function distanceFromEven(contract: GeminiContract): number | null {
  const { bid, ask, last } = yesQuote(contract);
  // Used only to rank contracts for selection, never for money.
  const mid =
    bid !== null && ask !== null ? (Number(bid) + Number(ask)) / 2 : Number(bid ?? ask ?? last);
  if (bid === null && ask === null && last === null) return null;
  return Math.abs(mid - 0.5);
}

/**
 * Chooses which contracts of an event to track.
 *
 * `pinnedSymbols` are this event's contracts that are already tracked. Once chosen they
 * are kept, so a "nearest the money" pick does not jump to another contract as prices
 * move and leave a chart with a gap.
 */
export function selectContracts(
  event: GeminiEvent,
  pick: ContractPick,
  pinnedSymbols: readonly string[],
): GeminiContract[] {
  if (pinnedSymbols.length > 0) {
    return event.contracts.filter((c) => pinnedSymbols.includes(c.instrumentSymbol));
  }
  if (pick.kind === 'all') return event.contracts;
  if (pick.kind === 'tickers') {
    return event.contracts.filter((c) => pick.tickers.includes(c.ticker));
  }
  return event.contracts
    .filter((c) => c.marketState === 'open')
    .map((contract) => ({ contract, distance: distanceFromEven(contract) }))
    .filter((entry): entry is { contract: GeminiContract; distance: number } => entry.distance !== null)
    .sort((a, b) => a.distance - b.distance || a.contract.ticker.localeCompare(b.contract.ticker))
    .slice(0, pick.count)
    .map((entry) => entry.contract);
}
