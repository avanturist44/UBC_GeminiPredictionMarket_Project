import { ARENA_ROSTER, type ModelId } from '@thesis/core';
import type { ArenaData, ArenaRun, RaceMarket, RaceTrade } from '@thesis/db';
import {
  MODEL_BY_ID,
  type ArenaMatchup,
  type ArenaMessage,
  type ArenaPoint,
  type ArenaPosition,
  type ArenaResponse,
  type ArenaStanding,
  type ArenaTrade,
} from './arena-view';
import { equityAt, histories, isOpen, pricer, type Pricer } from './ledger';
import { dealLabel } from './race';

/**
 * Builds the model arena from what the database holds: each model's own trades, valued the
 * way the race values them, and its own looks. Pure: the same rows and the same `now` give
 * the same arena. Names come from the roster, never from the authors table.
 */

/** Points on the chart. The database thins prices to the same number of slots. */
export const ARENA_SLOTS = 96;
/** The latest looks per model that the chat shows. */
export const ARENA_RUNS_PER_MODEL = 12;
const MAX_TRADES = 60;
/** Below this, two account values are level. */
const LEVEL_USD = 0.005;

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

interface Model {
  id: ModelId;
  agentKey: string;
  /** Oldest first. */
  trades: RaceTrade[];
}

export function buildArena(data: ArenaData, options: { now: Date; bankrollUsd: number }): ArenaResponse {
  const now = options.now.getTime();
  const bankroll = options.bankrollUsd;
  const markets = new Map(data.markets.map((m) => [m.id, m]));
  const p = pricer(markets, histories(data.prices), now);
  const agents = new Map(data.agents.map((a) => [a.agentKey, a]));
  const models: Model[] = ARENA_ROSTER.map((e) => ({ id: e.id, agentKey: e.agentKey, trades: agents.get(e.agentKey)?.trades ?? [] }));
  const label = (marketId: string) => {
    const market = markets.get(marketId);
    return market ? dealLabel(market) : 'A market';
  };

  const standings: ArenaStanding[] = models.map((m) => {
    const valueUsd = round2(equityAt(m.trades, bankroll, p, now));
    const changeUsd = round2(valueUsd - bankroll);
    const wallet = data.wallets.get(m.agentKey);
    return { id: m.id, valueUsd, changeUsd, changePct: (changeUsd / bankroll) * 100, ...(wallet ? { walletAddress: wallet } : {}) };
  });

  // From the first trade any model made to now. Before any trade there is nothing to draw.
  const since = data.since?.getTime() ?? null;
  const points: ArenaPoint[] = [];
  if (since !== null && since < now) {
    for (let i = 0; i <= ARENA_SLOTS; i += 1) {
      const t = i === ARENA_SLOTS ? now : since + ((now - since) * i) / ARENA_SLOTS;
      const point = { t } as ArenaPoint;
      for (const m of models) point[m.id] = round2(equityAt(m.trades, bankroll, p, t));
      points.push(point);
    }
  }

  const trades: ArenaTrade[] = models
    .flatMap((m) =>
      m.trades
        .filter((trade) => !isOpen(trade, markets.get(trade.marketId)))
        .map((trade) => {
          const quantity = Number(trade.quantity);
          // A payout once the resolver has paid it; until then 1 or 0 a contract, or the stake back if void.
          const value = p.value(trade, now);
          return {
            id: trade.id,
            model: m.id,
            market: label(trade.marketId),
            side: trade.side,
            quantity,
            entryPrice: Number(trade.price),
            exitPrice: quantity > 0 ? round4(value / quantity) : 0,
            pnlUsd: round2(value - Number(trade.costUsd)),
            openedAt: trade.createdAt.toISOString(),
            closedAt: (markets.get(trade.marketId)?.resolvedAt ?? options.now).toISOString(),
          };
        }),
    )
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, MAX_TRADES);

  const positions: ArenaPosition[] = models
    .flatMap((m) =>
      m.trades
        .filter((trade) => isOpen(trade, markets.get(trade.marketId)))
        .map((trade) => {
          const entryPrice = Number(trade.price);
          return {
            id: trade.id,
            model: m.id,
            market: label(trade.marketId),
            side: trade.side,
            quantity: Number(trade.quantity),
            entryPrice,
            // No quote yet: held at what it cost, as the account value holds it.
            markPrice: round4(p.mark(trade, now) ?? entryPrice),
            pnlUsd: round2(p.value(trade, now) - Number(trade.costUsd)),
            openedAt: trade.createdAt.toISOString(),
          };
        }),
    )
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));

  const messages: ArenaMessage[] = models
    .flatMap((m) => (data.runs.get(m.agentKey) ?? []).flatMap((run) => (run.reason ? [message(m.id, run, run.reason)] : [])))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    asOf: options.now.toISOString(),
    sample: false,
    bankrollUsd: bankroll,
    since: (data.since ?? options.now).toISOString(),
    standings,
    points,
    trades,
    positions,
    messages,
    matchup: matchupOf(models, standings, markets, p, now),
  };
}

/** Ends a headline as a sentence, unless it already ends like one. */
const sentence = (text: string) => (/[.?!…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A look, as the model's message: what it looked at, the thesis it sent if it traded, and why. */
function message(model: ModelId, run: ArenaRun, reason: string): ArenaMessage {
  const market = run.marketTitle ? dealLabel({ title: run.marketTitle, contractLabel: run.contractLabel }) : null;
  const what = `${run.decision === 'trade' ? 'Traded' : 'Passed'}${market ? ` on ${market}` : ''}.`;
  const headline = run.decision === 'trade' && run.thesisHeadline ? sentence(run.thesisHeadline) : null;
  return {
    id: `${model}:${run.createdAt.getTime()}`,
    model,
    at: run.createdAt.toISOString(),
    text: [what, headline, reason].filter(Boolean).join(' '),
    ...(run.searchSuggestionsHtml ? { searchSuggestionsHtml: run.searchSuggestionsHtml } : {}),
  };
}

/**
 * Who to name on the invitation, by the sample's rule: the model in front, the one it has
 * beaten by most on a single market, and that market. "Outperform" is only said of a leader
 * that has traded, about a model with a lower account value: sitting out while others lose
 * is not outperforming.
 */
function matchupOf(
  models: Model[],
  standings: ArenaStanding[],
  markets: Map<string, RaceMarket>,
  p: Pricer,
  now: number,
): ArenaMatchup | null {
  const tradesOf = new Map(models.map((m) => [m.id, m.trades]));
  const traded = (id: ModelId) => (tradesOf.get(id)?.length ?? 0) > 0;
  // Level at the front, a model that has traded leads.
  const ranked = [...standings].sort((a, b) => b.valueUsd - a.valueUsd || Number(traded(b.id)) - Number(traded(a.id)));
  const leader = ranked[0];
  if (!leader || !traded(leader.id)) return null;

  const pnl = (id: ModelId) => {
    const out = new Map<string, number>();
    for (const trade of tradesOf.get(id) ?? []) {
      out.set(trade.marketId, (out.get(trade.marketId) ?? 0) + p.value(trade, now) - Number(trade.costUsd));
    }
    return out;
  };
  const ahead = pnl(leader.id);
  let best: { trailer: ArenaStanding; marketId: string; edge: number } | null = null;
  for (const other of ranked.slice(1)) {
    if (leader.valueUsd - other.valueUsd < LEVEL_USD) continue;
    const behind = pnl(other.id);
    for (const marketId of new Set([...ahead.keys(), ...behind.keys()])) {
      const edge = (ahead.get(marketId) ?? 0) - (behind.get(marketId) ?? 0);
      if (!best || edge > best.edge) best = { trailer: other, marketId, edge };
    }
  }
  if (!best) return null;
  const market = markets.get(best.marketId);
  return {
    leader: leader.id,
    trailer: best.trailer.id,
    deal: best.edge > LEVEL_USD && market ? dealLabel(market) : null,
    gapUsd: round2(leader.valueUsd - best.trailer.valueUsd),
    headline: `Watch ${MODEL_BY_ID[leader.id].name} outperform ${MODEL_BY_ID[best.trailer.id].name}`,
  };
}
