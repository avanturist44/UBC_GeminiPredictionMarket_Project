import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { agentRuns, authors, markets, pricePoints, theses, trades, type TradeStatus } from '../schema';

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

export interface RaceTrade {
  id: string;
  marketId: string;
  side: 'yes' | 'no';
  quantity: string;
  price: string;
  costUsd: string;
  status: TradeStatus;
  payoutUsd: string | null;
  createdAt: Date;
  thesis: {
    id: string;
    headline: string;
    body: string;
    probabilityYes: string;
    publishedAt: Date | null;
  } | null;
}

export interface RaceMarket {
  id: string;
  instrumentSymbol: string;
  title: string;
  contractLabel: string | null;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
  resolutionSide: 'yes' | 'no' | null;
  resolvedAt: Date | null;
  status: string | null;
}

export interface RacePrice {
  marketId: string;
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
}

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

/** Trades that cost the agent money: open or settled, never rejected or still waiting. */
const COUNTED: TradeStatus[] = ['filled', 'partial', 'settled'];

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
              inArray(trades.status, COUNTED),
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

  const marketRows = await db
    .select({
      id: markets.id,
      instrumentSymbol: markets.instrumentSymbol,
      title: markets.title,
      contractLabel: markets.contractLabel,
      yesBid: markets.yesBid,
      yesAsk: markets.yesAsk,
      lastPrice: markets.lastPrice,
      resolutionSide: markets.resolutionSide,
      resolvedAt: markets.resolvedAt,
      status: markets.status,
    })
    .from(markets)
    .where(inArray(markets.id, marketIds));

  // One point per market per slot: the last quote recorded in it. The recorder writes every
  // few seconds, so a day of raw points would be thousands of rows per market.
  const slotSeconds = Math.max(1, Math.ceil((options.now.getTime() - since.getTime()) / 1000 / Math.max(1, options.slots)));
  // The slot is computed once, in a subquery: DISTINCT ON must name the same expression as
  // ORDER BY, and two copies of a parameterised expression do not count as the same.
  const slotted = db
    .select({
      marketId: pricePoints.marketId,
      ts: pricePoints.ts,
      yesBid: pricePoints.yesBid,
      yesAsk: pricePoints.yesAsk,
      lastPrice: pricePoints.lastPrice,
      slot: sql<Date>`date_bin(make_interval(secs => ${slotSeconds}), ${pricePoints.ts}, ${since.toISOString()}::timestamptz)`.as('slot'),
    })
    .from(pricePoints)
    .where(and(inArray(pricePoints.marketId, marketIds), gte(pricePoints.ts, since), lte(pricePoints.ts, options.now)))
    .as('slotted');
  const priceRows = await db
    .selectDistinctOn([slotted.marketId, slotted.slot], {
      marketId: slotted.marketId,
      ts: slotted.ts,
      yesBid: slotted.yesBid,
      yesAsk: slotted.yesAsk,
      lastPrice: slotted.lastPrice,
    })
    .from(slotted)
    .orderBy(slotted.marketId, slotted.slot, desc(slotted.ts));

  return { agents, markets: marketRows, prices: priceRows, since };
}
