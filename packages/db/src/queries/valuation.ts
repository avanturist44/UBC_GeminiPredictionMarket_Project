import { and, desc, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { markets, pricePoints, type TradeStatus } from '../schema';

/**
 * What it takes to value positions over time: the markets they sit on, and each market's
 * recorded prices thinned to one point per time slot. The agent race and a user's account
 * chart both read through here.
 */

/** A position as valuation needs it. */
export interface ValuedTrade {
  id: string;
  marketId: string;
  side: 'yes' | 'no';
  quantity: string;
  price: string;
  costUsd: string;
  status: TradeStatus;
  payoutUsd: string | null;
  createdAt: Date;
}

export interface ValuationMarket {
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

export interface ValuationPrice {
  marketId: string;
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
}

/** Trades that cost money: open or settled, never rejected or still waiting. */
export const COUNTED_TRADES: TradeStatus[] = ['filled', 'partial', 'settled'];

export async function getValuationMarkets(db: Db, marketIds: readonly string[]): Promise<ValuationMarket[]> {
  if (marketIds.length === 0) return [];
  return db
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
    .where(inArray(markets.id, [...marketIds]));
}

/**
 * One point per market per slot between `since` and `now`: the last quote recorded in it.
 * The recorder writes every few seconds, so a day of raw points would be thousands of rows
 * per market.
 */
export async function getSlottedPrices(
  db: Db,
  options: { marketIds: readonly string[]; since: Date; now: Date; slots: number },
): Promise<ValuationPrice[]> {
  const { marketIds, since, now } = options;
  if (marketIds.length === 0) return [];
  const slotSeconds = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 1000 / Math.max(1, options.slots)));
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
    .where(and(inArray(pricePoints.marketId, [...marketIds]), gte(pricePoints.ts, since), lte(pricePoints.ts, now)))
    .as('slotted');
  return db
    .selectDistinctOn([slotted.marketId, slotted.slot], {
      marketId: slotted.marketId,
      ts: slotted.ts,
      yesBid: slotted.yesBid,
      yesAsk: slotted.yesAsk,
      lastPrice: slotted.lastPrice,
    })
    .from(slotted)
    .orderBy(slotted.marketId, slotted.slot, desc(slotted.ts));
}
