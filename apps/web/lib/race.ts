import type { RaceData, RaceMarket, RacePrice, RaceTrade } from '@thesis/db';
import type {
  RaceMark,
  RaceMarketRef,
  RacePoint,
  RacePositionView,
  RaceResponse,
  RaceSideView,
  RaceSlot,
} from './race-view';

/**
 * Builds the race from what the database holds. Pure: the same rows and the same `now` give
 * the same race, which is what the tests pin down.
 */

/** The races that exist, by address. Agent keys in the order they are drawn. */
export const RACES: Record<string, { a: string; b: string }> = {
  'news-vs-fade': { a: 'news', b: 'fade' },
};
export const DEFAULT_RACE = 'news-vs-fade';

/** Below this, two account values are level. */
const LEVEL_USD = 0.005;
/** Points on the full chart. The database thins prices to the same number of slots. */
export const RACE_SLOTS = 96;
const MAX_MARKS = 60;

const money = (value: number) => value.toFixed(2);
const price = (value: number) => value.toFixed(4);

/** "Oil (Brent) price on November 18?" and "$90 or above" read as one deal. */
export function dealLabel(market: Pick<RaceMarketRef, 'title' | 'contractLabel'>): string {
  const title = market.title.replace(/\?\s*$/, '');
  return market.contractLabel ? `${title}, ${market.contractLabel}` : title;
}

/** The YES midpoint of a quote, or the last trade, or whichever side exists. */
function yesMid(bid: string | null, ask: string | null, last: string | null): number | null {
  if (bid !== null && ask !== null) return (Number(bid) + Number(ask)) / 2;
  if (last !== null) return Number(last);
  if (bid !== null) return Number(bid);
  if (ask !== null) return Number(ask);
  return null;
}

interface History {
  times: number[];
  mids: number[];
}

/** The latest midpoint recorded at or before `t`, by binary search. */
function midAt(history: History | undefined, t: number): number | null {
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

function histories(prices: RacePrice[]): Map<string, History> {
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

interface Pricer {
  /** What one contract of the trade's side is worth at `t`. Null when nothing is known. */
  mark(trade: RaceTrade, t: number): number | null;
  /** What the trade is worth at `t`: a payout once settled, otherwise contracts at the mark. */
  value(trade: RaceTrade, t: number): number;
}

function pricer(markets: Map<string, RaceMarket>, prices: Map<string, History>, now: number): Pricer {
  function mark(trade: RaceTrade, t: number): number | null {
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
function equityAt(trades: RaceTrade[], bankroll: number, p: Pricer, t: number): number {
  let total = bankroll;
  for (const trade of trades) {
    if (trade.createdAt.getTime() > t) break;
    total += p.value(trade, t) - Number(trade.costUsd);
  }
  return total;
}

function isOpen(trade: RaceTrade, market: RaceMarket | undefined): boolean {
  return trade.status !== 'settled' && !market?.resolvedAt;
}

function marketRef(market: RaceMarket): RaceMarketRef {
  return { symbol: market.instrumentSymbol, title: market.title, contractLabel: market.contractLabel };
}

export function buildRace(
  pair: string,
  data: RaceData,
  options: { now: Date; bankrollUsd: number; slots?: number },
): RaceResponse {
  const now = options.now.getTime();
  const bankroll = options.bankrollUsd;
  const markets = new Map(data.markets.map((m) => [m.id, m]));
  const p = pricer(markets, histories(data.prices), now);
  const [first, second] = data.agents;
  if (!first || !second) throw new Error('A race needs two agents');
  const sides = { a: first, b: second } as const;

  const side = (slot: RaceSlot): RaceSideView => {
    const agent = sides[slot];
    const value = equityAt(agent.trades, bankroll, p, now);
    const open = agent.trades.filter((trade) => isOpen(trade, markets.get(trade.marketId)));
    const positions: RacePositionView[] = open
      .map((trade) => {
        const market = markets.get(trade.marketId)!;
        const markPrice = p.mark(trade, now);
        const valueUsd = p.value(trade, now);
        return {
          tradeId: trade.id,
          market: marketRef(market),
          side: trade.side,
          quantity: trade.quantity,
          entryPrice: trade.price,
          markPrice: markPrice === null ? null : price(markPrice),
          costUsd: money(Number(trade.costUsd)),
          valueUsd: money(valueUsd),
          pnlUsd: money(valueUsd - Number(trade.costUsd)),
          openedAt: trade.createdAt.toISOString(),
          thesisId: trade.thesis?.id ?? null,
        };
      })
      .reverse();
    const withThesis = [...open].reverse().find((t) => t.thesis) ?? [...agent.trades].reverse().find((t) => t.thesis);
    const thesis = withThesis?.thesis ?? null;
    const run = agent.latestRun;
    return {
      slot,
      agentKey: agent.agentKey,
      name: agent.author?.displayName ?? agent.agentKey,
      authorId: agent.author?.id ?? null,
      strategy: agent.author?.strategySummary ?? null,
      valueUsd: money(value),
      changeUsd: money(value - bankroll),
      tradeCount: agent.trades.length,
      positions,
      thesis: thesis
        ? {
            id: thesis.id,
            headline: thesis.headline,
            body: thesis.body,
            probabilityYes: thesis.probabilityYes,
            at: thesis.publishedAt?.toISOString() ?? null,
          }
        : null,
      lastLook:
        run && run.reason
          ? {
              decision: run.decision,
              reason: run.reason,
              at: run.createdAt.toISOString(),
              market: run.marketTitle ? dealLabel({ title: run.marketTitle, contractLabel: run.contractLabel }) : null,
            }
          : null,
    };
  };

  const a = side('a');
  const b = side('b');
  const diff = Number(a.valueUsd) - Number(b.valueUsd);
  const leader: RaceSlot | null = Math.abs(diff) < LEVEL_USD ? null : diff > 0 ? 'a' : 'b';

  // The deal: where the leader gained most on the other, or the latest trade when level.
  const pnlByMarket = (slot: RaceSlot) => {
    const out = new Map<string, number>();
    for (const trade of sides[slot].trades) {
      out.set(trade.marketId, (out.get(trade.marketId) ?? 0) + p.value(trade, now) - Number(trade.costUsd));
    }
    return out;
  };
  let dealMarket: RaceMarket | undefined;
  if (leader) {
    const ahead = pnlByMarket(leader);
    const behind = pnlByMarket(leader === 'a' ? 'b' : 'a');
    let best = LEVEL_USD;
    for (const id of new Set([...ahead.keys(), ...behind.keys()])) {
      const edge = (ahead.get(id) ?? 0) - (behind.get(id) ?? 0);
      if (edge > best) {
        best = edge;
        dealMarket = markets.get(id);
      }
    }
  } else {
    const latest = [...first.trades, ...second.trades].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
    dealMarket = latest ? markets.get(latest.marketId) : undefined;
  }
  const deal = dealMarket ? { ...marketRef(dealMarket), label: dealLabel(dealMarket) } : null;

  // "Outperform" only when it is true, and only for an agent that has actually traded:
  // sitting out while the other loses is not outperforming.
  const leaderSide = leader ? (leader === 'a' ? a : b) : null;
  const trailerSide = leader ? (leader === 'a' ? b : a) : null;
  const headline =
    leaderSide && trailerSide && leaderSide.tradeCount > 0
      ? `Watch ${leaderSide.name} outperform ${trailerSide.name}`
      : a.tradeCount + b.tradeCount > 0
        ? `Watch ${a.name} and ${b.name} trade`
        : `Watch ${a.name} and ${b.name} race`;

  const since = data.since?.getTime() ?? null;
  const points: RacePoint[] = [];
  const marks: RaceMark[] = [];
  if (since !== null && since < now) {
    const slots = Math.max(2, options.slots ?? RACE_SLOTS);
    for (let i = 0; i <= slots; i += 1) {
      const t = i === slots ? now : since + ((now - since) * i) / slots;
      points.push({ t, a: round(equityAt(first.trades, bankroll, p, t)), b: round(equityAt(second.trades, bankroll, p, t)) });
    }
    for (const slot of ['a', 'b'] as const) {
      for (const trade of sides[slot].trades) {
        const market = markets.get(trade.marketId);
        const t = trade.createdAt.getTime();
        marks.push({
          id: trade.id,
          t,
          slot,
          side: trade.side,
          value: round(equityAt(sides[slot].trades, bankroll, p, t)),
          market: market ? dealLabel(market) : 'A market',
        });
      }
    }
    marks.sort((x, y) => x.t - y.t);
  }

  return {
    asOf: options.now.toISOString(),
    pair,
    bankrollUsd: bankroll,
    since: data.since?.toISOString() ?? null,
    a,
    b,
    leader,
    leadUsd: money(Math.abs(diff)),
    deal,
    headline,
    points,
    marks: marks.slice(-MAX_MARKS),
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
