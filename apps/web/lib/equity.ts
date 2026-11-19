import type { ValuationMarket, ValuationPrice, ValuedTrade } from '@thesis/db';

/**
 * What positions are worth over time, from recorded prices. Pure, and shared by the agent
 * race and a user's account chart, so both value a position the same way: at the YES
 * midpoint for its side, at 1 or 0 once the market resolves, and at its cost before any
 * price is known.
 */

/** The YES midpoint of a quote, or the last trade, or whichever side exists. */
export function yesMid(bid: string | null, ask: string | null, last: string | null): number | null {
  if (bid !== null && ask !== null) return (Number(bid) + Number(ask)) / 2;
  if (last !== null) return Number(last);
  if (bid !== null) return Number(bid);
  if (ask !== null) return Number(ask);
  return null;
}

export interface History {
  times: number[];
  mids: number[];
}

/** The latest midpoint recorded at or before `t`, by binary search. */
export function midAt(history: History | undefined, t: number): number | null {
  if (!history || history.times.length === 0) return null;
  let lo = 0;
  let hi = history.times.length - 1;
  if (history.times[0]! > t) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (history.times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return history.mids[lo]!;
}

export function histories(prices: ValuationPrice[]): Map<string, History> {
  const out = new Map<string, History>();
  for (const point of prices) {
    const mid = yesMid(point.yesBid, point.yesAsk, point.lastPrice);
    if (mid === null) continue;
    const history = out.get(point.marketId) ?? { times: [], mids: [] };
    history.times.push(point.ts.getTime());
    history.mids.push(mid);
    out.set(point.marketId, history);
  }
  for (const history of out.values()) {
    const order = history.times.map((_, i) => i).sort((x, y) => history.times[x]! - history.times[y]!);
    history.times = order.map((i) => history.times[i]!);
    history.mids = order.map((i) => history.mids[i]!);
  }
  return out;
}

export interface Pricer {
  /** What one contract of the trade's side is worth at `t`. Null when nothing is known. */
  mark(trade: ValuedTrade, t: number): number | null;
  /** What the trade is worth at `t`: a payout once settled, otherwise contracts at the mark. */
  value(trade: ValuedTrade, t: number): number;
}

export function pricer(markets: Map<string, ValuationMarket>, prices: Map<string, History>, now: number): Pricer {
  function mark(trade: ValuedTrade, t: number): number | null {
    const market = markets.get(trade.marketId);
    if (!market) return null;
    const resolvedAt = market.resolvedAt?.getTime() ?? null;
    if (resolvedAt !== null && resolvedAt <= t) {
      // A result is known: the side pays 1 or 0. A void market hands the stake back.
      if (market.resolutionSide) return trade.side === market.resolutionSide ? 1 : 0;
      return Number(trade.price);
    }
    const mid = t >= now ? (yesMid(market.yesBid, market.yesAsk, market.lastPrice) ?? midAt(prices.get(market.id), t)) : midAt(prices.get(market.id), t);
    if (mid === null) return null;
    return trade.side === 'yes' ? mid : 1 - mid;
  }
  return {
    mark,
    value(trade, t) {
      const market = markets.get(trade.marketId);
      const resolvedAt = market?.resolvedAt?.getTime() ?? null;
      if (trade.status === 'settled' && trade.payoutUsd !== null && resolvedAt !== null && resolvedAt <= t) {
        return Number(trade.payoutUsd);
      }
      // No quote yet: hold it at what it cost, so a new position neither gains nor loses.
      return Number(trade.quantity) * (mark(trade, t) ?? Number(trade.price));
    },
  };
}

/** Bankroll, less what was paid, plus what positions are worth at `t`. */
export function equityAt(trades: readonly ValuedTrade[], bankroll: number, p: Pricer, t: number): number {
  let total = bankroll;
  for (const trade of trades) {
    if (trade.createdAt.getTime() > t) break;
    total += p.value(trade, t) - Number(trade.costUsd);
  }
  return total;
}
