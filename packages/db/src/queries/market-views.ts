import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { authors, markets, pricePoints, theses } from '../schema';

/** Read models behind the Markets tab: `GET /api/markets` and `GET /api/markets/[symbol]`. */

/** A thesis counts once it is public: published, or published and since resolved. */
const PUBLIC_THESIS_STATUSES = ['published', 'resolved'] as const;

export interface MarketRow {
  instrumentSymbol: string;
  eventTicker: string;
  contractTicker: string;
  title: string;
  contractLabel: string | null;
  category: string | null;
  expiryAt: Date | null;
  status: string | null;
  marketState: string | null;
  strike: string | null;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
  resolutionSide: 'yes' | 'no' | null;
  resolvedAt: Date | null;
  updatedAt: Date;
  /** Public theses arguing each side. */
  thesesYes: number;
  thesesNo: number;
}

function selectMarketRows(db: Db) {
  const counts = db
    .select({
      marketId: theses.marketId,
      yes: sql<number>`(count(*) filter (where ${theses.side} = 'yes'))::int`.as('theses_yes'),
      no: sql<number>`(count(*) filter (where ${theses.side} = 'no'))::int`.as('theses_no'),
    })
    .from(theses)
    .where(inArray(theses.status, PUBLIC_THESIS_STATUSES))
    .groupBy(theses.marketId)
    .as('counts');

  return db
    .select({
      id: markets.id,
      instrumentSymbol: markets.instrumentSymbol,
      eventTicker: markets.eventTicker,
      contractTicker: markets.contractTicker,
      title: markets.title,
      contractLabel: markets.contractLabel,
      category: markets.category,
      expiryAt: markets.expiryAt,
      status: markets.status,
      marketState: markets.marketState,
      strike: markets.strike,
      yesBid: markets.yesBid,
      yesAsk: markets.yesAsk,
      lastPrice: markets.lastPrice,
      resolutionSide: markets.resolutionSide,
      resolvedAt: markets.resolvedAt,
      updatedAt: markets.updatedAt,
      thesesYes: sql<number>`coalesce(${counts.yes}, 0)`.mapWith(Number),
      thesesNo: sql<number>`coalesce(${counts.no}, 0)`.mapWith(Number),
    })
    .from(markets)
    .leftJoin(counts, eq(counts.marketId, markets.id));
}

/** Tracked contracts that have not expired, soonest expiry first. */
export async function listOpenMarkets(db: Db, now: Date): Promise<MarketRow[]> {
  const rows = await selectMarketRows(db)
    .where(
      and(
        eq(markets.tracked, true),
        sql`(${markets.expiryAt} is null or ${markets.expiryAt} > ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(sql`${markets.expiryAt} asc nulls last`, asc(markets.instrumentSymbol));
  return rows.map(({ id: _id, ...row }) => row);
}

export interface PricePointRow {
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
}

/** A public thesis on the market, as the chart marks it. */
export interface ThesisMarkerRow {
  id: string;
  headline: string;
  side: 'yes' | 'no';
  probabilityYes: string;
  publishedAt: Date | null;
  authorKind: 'agent' | 'human';
  authorName: string;
}

export interface MarketDetail {
  market: MarketRow;
  /** Oldest first, thinned to at most `maxPoints`. */
  points: PricePointRow[];
  /** Oldest first. */
  theses: ThesisMarkerRow[];
}

const pointColumns = {
  ts: pricePoints.ts,
  yesBid: pricePoints.yesBid,
  yesAsk: pricePoints.yesAsk,
  lastPrice: pricePoints.lastPrice,
};

/**
 * A market's price history, thinned to at most `maxPoints` rows: the history is cut into
 * equal time slices and the newest point of each slice is kept, so the latest point always
 * survives and a chart of days costs the same as a chart of minutes.
 */
async function loadPricePoints(
  db: Db,
  marketId: string,
  maxPoints: number,
  from: Date | null,
): Promise<PricePointRow[]> {
  const ofMarket = from
    ? and(eq(pricePoints.marketId, marketId), gte(pricePoints.ts, from))
    : eq(pricePoints.marketId, marketId);
  const [bounds] = await db
    .select({
      count: sql<number>`count(*)::int`,
      first: sql<Date | null>`min(${pricePoints.ts})`.mapWith(pricePoints.ts),
      last: sql<Date | null>`max(${pricePoints.ts})`.mapWith(pricePoints.ts),
    })
    .from(pricePoints)
    .where(ofMarket);

  if (!bounds || !bounds.first || !bounds.last || bounds.count <= maxPoints) {
    return db.select(pointColumns).from(pricePoints).where(ofMarket).orderBy(asc(pricePoints.ts));
  }

  const first = bounds.first.toISOString();
  const sliceSeconds = Math.max((bounds.last.getTime() - bounds.first.getTime()) / 1000 / maxPoints, 0.001);
  const sliced = db
    .select({
      ...pointColumns,
      slice: sql<number>`least(
        floor(extract(epoch from (${pricePoints.ts} - ${first}::timestamptz)) / ${sliceSeconds}::float8),
        ${maxPoints - 1}::float8
      )`.as('slice'),
    })
    .from(pricePoints)
    .where(ofMarket)
    .as('sliced');

  return db
    .selectDistinctOn([sliced.slice], {
      ts: sliced.ts,
      yesBid: sliced.yesBid,
      yesAsk: sliced.yesAsk,
      lastPrice: sliced.lastPrice,
    })
    .from(sliced)
    .orderBy(asc(sliced.slice), desc(sliced.ts));
}

/** Null when no tracked contract has this symbol. An expired contract is still returned. */
export async function getMarketDetail(
  db: Db,
  instrumentSymbol: string,
  options: {
    maxPoints?: number;
    /** Where the price history should start for this market. Null for all of it. */
    pointsFrom?: (market: MarketRow) => Date | null;
  } = {},
): Promise<MarketDetail | null> {
  const [found] = await selectMarketRows(db)
    .where(and(eq(markets.instrumentSymbol, instrumentSymbol), eq(markets.tracked, true)))
    .limit(1);
  if (!found) return null;
  const { id, ...market } = found;

  const [points, thesisRows] = await Promise.all([
    loadPricePoints(db, id, options.maxPoints ?? 500, options.pointsFrom?.(market) ?? null),
    db
      .select({
        id: theses.id,
        headline: theses.headline,
        side: theses.side,
        probabilityYes: theses.probabilityYes,
        publishedAt: theses.publishedAt,
        authorKind: authors.kind,
        authorName: authors.displayName,
      })
      .from(theses)
      .innerJoin(authors, eq(authors.id, theses.authorId))
      .where(and(eq(theses.marketId, id), inArray(theses.status, PUBLIC_THESIS_STATUSES)))
      .orderBy(asc(theses.publishedAt), asc(theses.id)),
  ]);

  return { market, points, theses: thesisRows };
}
