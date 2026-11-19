import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from '../client';
import { agentRuns, authors, markets, theses, trades } from '../schema';
import {
  COUNTED_TRADES,
  getSlottedPrices,
  getValuationMarkets,
  type ValuationMarket,
  type ValuationPrice,
  type ValuedTrade,
} from './valuation';

/**
 * What the agent race needs, read in one go: each agent's own positions (never the trades of
 * people who copied it), the thesis behind each position, its latest decision, and the
 * price history of every market it traded, thinned to one point per time slot.
 */

export interface RaceAuthor {
  id: string;
  agentKey: string;
  displayName: string;
  strategySummary: string | null;
}

export interface RaceTrade extends ValuedTrade {
  thesis: {
    id: string;
    headline: string;
    body: string;
    probabilityYes: string;
    publishedAt: Date | null;
  } | null;
}

export type RaceMarket = ValuationMarket;
export type RacePrice = ValuationPrice;

export interface RaceRun {
  decision: 'trade' | 'skip';
  reason: string | null;
  createdAt: Date;
  marketTitle: string | null;
  contractLabel: string | null;
}

export interface RaceAgent {
  agentKey: string;
  author: RaceAuthor | null;
  trades: RaceTrade[];
  latestRun: RaceRun | null;
}

export interface RaceData {
  agents: RaceAgent[];
  markets: RaceMarket[];
  prices: RacePrice[];
  /** The first position either agent opened: where the race starts. Null before any trade. */
  since: Date | null;
}

export async function getRaceData(
  db: Db,
  agentKeys: readonly string[],
  options: { now: Date; slots: number },
): Promise<RaceData> {
  const authorRows = await db
    .select({
      id: authors.id,
      agentKey: authors.agentKey,
      displayName: authors.displayName,
      strategySummary: authors.strategySummary,
    })
    .from(authors)
    .where(and(eq(authors.kind, 'agent'), inArray(authors.agentKey, [...agentKeys])));
  const byKey = new Map(authorRows.map((row) => [row.agentKey, { ...row, agentKey: row.agentKey! }]));
  const authorIds = authorRows.map((row) => row.id);

  const tradeRows =
    authorIds.length === 0
      ? []
      : await db
          .select({
            trade: trades,
            thesis: {
              id: theses.id,
              headline: theses.headline,
              body: theses.body,
              probabilityYes: theses.probabilityYes,
              publishedAt: theses.publishedAt,
            },
          })
          .from(trades)
          .leftJoin(theses, eq(theses.id, trades.thesisId))
          .where(
            and(
              inArray(trades.authorId, authorIds),
              eq(trades.isAuthorPosition, true),
              inArray(trades.status, COUNTED_TRADES),
              lte(trades.createdAt, options.now),
            ),
          )
          .orderBy(asc(trades.createdAt));

  const agents: RaceAgent[] = [];
  for (const agentKey of agentKeys) {
    const author = byKey.get(agentKey) ?? null;
    const own = author ? tradeRows.filter((row) => row.trade.authorId === author.id) : [];
    const [run] = await db
      .select({
        decision: agentRuns.decision,
        reason: agentRuns.reason,
        createdAt: agentRuns.createdAt,
        marketTitle: markets.title,
        contractLabel: markets.contractLabel,
      })
      .from(agentRuns)
      .leftJoin(markets, eq(markets.id, agentRuns.marketId))
      .where(eq(agentRuns.agentKey, agentKey))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    agents.push({
      agentKey,
      author,
      latestRun: run ?? null,
      trades: own.map(({ trade, thesis }) => ({
        id: trade.id,
        marketId: trade.marketId,
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        costUsd: trade.costUsd,
        status: trade.status,
        payoutUsd: trade.payoutUsd,
        createdAt: trade.createdAt,
        thesis: thesis?.id ? thesis : null,
      })),
    });
  }

  const marketIds = [...new Set(tradeRows.map((row) => row.trade.marketId))];
  const since = tradeRows[0]?.trade.createdAt ?? null;
  if (marketIds.length === 0 || !since) return { agents, markets: [], prices: [], since: null };

  const [marketRows, priceRows] = await Promise.all([
    getValuationMarkets(db, marketIds),
    getSlottedPrices(db, { marketIds, since, now: options.now, slots: options.slots }),
  ]);

  return { agents, markets: marketRows, prices: priceRows, since };
}
