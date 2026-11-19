import type { RaceData, RaceMarket, RaceTrade } from '@thesis/db';
import { equityAt, histories, pricer } from './equity';
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
