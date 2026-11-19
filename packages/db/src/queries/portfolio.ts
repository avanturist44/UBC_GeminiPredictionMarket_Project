import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { authors, theses, tips, trades } from '../schema';
import {
  COUNTED_TRADES,
  getSlottedPrices,
  getValuationMarkets,
  type ValuationMarket,
  type ValuationPrice,
  type ValuedTrade,
} from './valuation';

/**
 * A user's account over time: every position they hold or held (copies and their own
 * theses alike), the markets under them, and those markets' recorded prices.
 */
export interface PortfolioData {
  trades: ValuedTrade[];
  markets: ValuationMarket[];
  prices: ValuationPrice[];
  /** The user's first position: where the account line starts. Null before any trade. */
  since: Date | null;
}

export async function getPortfolioData(
  db: Db,
  userId: string,
  options: { now: Date; slots: number },
): Promise<PortfolioData> {
  const rows = await db
    .select({
      id: trades.id,
      marketId: trades.marketId,
      side: trades.side,
      quantity: trades.quantity,
      price: trades.price,
      costUsd: trades.costUsd,
      status: trades.status,
      payoutUsd: trades.payoutUsd,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .where(
      and(eq(trades.userId, userId), inArray(trades.status, COUNTED_TRADES), lte(trades.createdAt, options.now)),
    )
    .orderBy(asc(trades.createdAt));
  const since = rows[0]?.createdAt ?? null;
  const marketIds = [...new Set(rows.map((row) => row.marketId))];
  if (!since) return { trades: rows, markets: [], prices: [], since: null };
  const [marketRows, priceRows] = await Promise.all([
    getValuationMarkets(db, marketIds),
    getSlottedPrices(db, { marketIds, since, now: options.now, slots: options.slots }),
  ]);
  return { trades: rows, markets: marketRows, prices: priceRows, since };
}

export interface AccountStats {
  /** Authors whose theses the user has copied. */
  copying: number;
  /** Other people who have copied a thesis the user wrote. */
  copiers: number;
  /** Tips paid to the user as an author, in USDC. */
  tipsEarnedUsdc: string;
}

export async function getAccountStats(db: Db, userId: string): Promise<AccountStats> {
  const [[copying], [copiers], [earned]] = await Promise.all([
    db
      .select({ count: sql<number>`count(distinct ${theses.authorId})::int` })
      .from(trades)
      .innerJoin(theses, eq(theses.id, trades.thesisId))
      .where(
        and(
          eq(trades.userId, userId),
          eq(trades.isAuthorPosition, false),
          inArray(trades.status, COUNTED_TRADES),
        ),
      ),
    db
      .select({ count: sql<number>`count(distinct ${trades.userId})::int` })
      .from(trades)
      .innerJoin(theses, eq(theses.id, trades.thesisId))
      .innerJoin(authors, eq(authors.id, theses.authorId))
      .where(
        and(
          eq(authors.userId, userId),
          eq(trades.isAuthorPosition, false),
          inArray(trades.status, COUNTED_TRADES),
          ne(trades.userId, userId),
        ),
      ),
    db
      .select({ total: sql<string>`coalesce(sum(${tips.amountUsdc}), 0)::text` })
      .from(tips)
      .innerJoin(theses, eq(theses.id, tips.thesisId))
      .innerJoin(authors, eq(authors.id, theses.authorId))
      .where(and(eq(authors.userId, userId), eq(tips.status, 'paid'))),
  ]);
  return {
    copying: copying?.count ?? 0,
    copiers: copiers?.count ?? 0,
    tipsEarnedUsdc: earned?.total ?? '0',
  };
}
