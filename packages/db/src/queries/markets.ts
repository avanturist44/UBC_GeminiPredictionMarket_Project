import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { markets, pricePoints } from '../schema';

export interface MarketUpsert {
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
  keywords: string[][];
  quantityIncrement: string | null;
  quantityMinimum: string | null;
  priceIncrement: string | null;
  sourceDetails: { agency?: string | null; index?: string | null } | null;
}

/**
 * Inserts or refreshes a tracked contract, keyed by instrument symbol.
 * It never writes resolution_side or resolved_at: the resolver owns those,
 * because storing a result is what triggers settlement.
 */
export async function upsertMarket(db: Db, input: MarketUpsert): Promise<{ id: string }> {
  const values = { ...input, tracked: true };
  const { instrumentSymbol: _symbol, ...mutable } = values;
  const [row] = await db
    .insert(markets)
    .values(values)
    .onConflictDoUpdate({
      target: markets.instrumentSymbol,
      set: { ...mutable, updatedAt: sql`now()` },
    })
    .returning({ id: markets.id });
  if (!row) throw new Error(`upsertMarket returned no row for ${input.instrumentSymbol}`);
  return row;
}

/** Instrument symbols of an event's contracts that are already tracked. */
export async function listTrackedSymbolsForEvent(db: Db, eventTicker: string): Promise<string[]> {
  const rows = await db
    .select({ instrumentSymbol: markets.instrumentSymbol })
    .from(markets)
    .where(and(eq(markets.eventTicker, eventTicker), eq(markets.tracked, true)))
    .orderBy(asc(markets.instrumentSymbol));
  return rows.map((row) => row.instrumentSymbol);
}

export interface PricePointInsert {
  marketId: string;
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
  source: 'ws' | 'rest' | 'backfill';
}

export async function insertPricePoint(db: Db, point: PricePointInsert): Promise<void> {
  await db.insert(pricePoints).values(point);
}

export interface RecorderStatusRow {
  instrumentSymbol: string;
  title: string;
  contractLabel: string | null;
  expiryAt: Date | null;
  marketState: string | null;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
  /** Price points recorded at or after `since`. */
  points: number;
  latestTs: Date | null;
}

/** Tracked contracts that have not expired before `since`, with how much was recorded since then. */
export async function getRecorderStatus(db: Db, since: Date): Promise<RecorderStatusRow[]> {
  const recent = db
    .select({
      marketId: pricePoints.marketId,
      points: sql<number>`count(*)::int`.as('points'),
      latestTs: sql<Date>`max(${pricePoints.ts})`.mapWith(pricePoints.ts).as('latest_ts'),
    })
    .from(pricePoints)
    .where(gte(pricePoints.ts, since))
    .groupBy(pricePoints.marketId)
    .as('recent');

  const rows = await db
    .select({
      instrumentSymbol: markets.instrumentSymbol,
      title: markets.title,
      contractLabel: markets.contractLabel,
      expiryAt: markets.expiryAt,
      marketState: markets.marketState,
      yesBid: markets.yesBid,
      yesAsk: markets.yesAsk,
      lastPrice: markets.lastPrice,
      points: recent.points,
      latestTs: recent.latestTs,
    })
    .from(markets)
    .leftJoin(recent, eq(recent.marketId, markets.id))
    .where(
      and(
        eq(markets.tracked, true),
        sql`(${markets.expiryAt} is null or ${markets.expiryAt} >= ${since.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(markets.expiryAt), asc(markets.instrumentSymbol));

  return rows.map((row) => ({ ...row, points: row.points ?? 0, latestTs: row.latestTs ?? null }));
}
