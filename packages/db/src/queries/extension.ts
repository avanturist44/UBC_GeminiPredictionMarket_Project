import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { authors, markets, theses } from '../schema';
import { getAuthorRecords, type AuthorRecord } from './theses';

/** Read models behind the Chrome extension: `GET /api/ext/markets` and `GET /api/ext/card`. */

const PUBLIC_THESIS_STATUSES = ['published', 'resolved'] as const;

export interface ExtensionMarketRow {
  instrumentSymbol: string;
  title: string;
  contractLabel: string | null;
  keywords: string[][];
  /** Public theses on the market. */
  theses: number;
}

/**
 * Tracked contracts that have not expired and have keyword groups, most theses first.
 * Several contracts share keywords (every Bitcoin market matches "bitcoin"), and the
 * extension gives a tie to the first one listed, so the one with something to show wins.
 */
export async function listExtensionMarkets(db: Db, now: Date): Promise<ExtensionMarketRow[]> {
  const counts = db
    .select({ marketId: theses.marketId, total: sql<number>`count(*)::int`.as('total') })
    .from(theses)
    .where(inArray(theses.status, PUBLIC_THESIS_STATUSES))
    .groupBy(theses.marketId)
    .as('counts');

  return db
    .select({
      instrumentSymbol: markets.instrumentSymbol,
      title: markets.title,
      contractLabel: markets.contractLabel,
      keywords: markets.keywords,
      theses: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
    })
    .from(markets)
    .leftJoin(counts, eq(counts.marketId, markets.id))
    .where(
      and(
        eq(markets.tracked, true),
        sql`(${markets.expiryAt} is null or ${markets.expiryAt} > ${now.toISOString()}::timestamptz)`,
        sql`jsonb_array_length(${markets.keywords}) > 0`,
      ),
    )
    .orderBy(
      sql`coalesce(${counts.total}, 0) desc`,
      sql`${markets.expiryAt} asc nulls last`,
      asc(markets.instrumentSymbol),
    );
}

/** A public thesis on the market, with what the card shows about it and its author. */
export interface ExtensionThesisRow {
  id: string;
  side: 'yes' | 'no';
  probabilityYes: string;
  entryPrice: string | null;
  headline: string;
  body: string;
  publishedAt: Date | null;
  authorId: string;
  authorKind: 'agent' | 'human';
  authorName: string;
  record: AuthorRecord;
}

export interface ExtensionCardData {
  market: {
    instrumentSymbol: string;
    title: string;
    contractLabel: string | null;
    yesBid: string | null;
    yesAsk: string | null;
    lastPrice: string | null;
  };
  /** Newest first. */
  theses: ExtensionThesisRow[];
}

const NO_RECORD: AuthorRecord = { resolved: 0, right: 0, brier: null, marketBrier: null };

/** Null when no tracked contract has this symbol. An expired contract is still returned. */
export async function getExtensionCard(db: Db, instrumentSymbol: string): Promise<ExtensionCardData | null> {
  const [market] = await db
    .select({
      id: markets.id,
      instrumentSymbol: markets.instrumentSymbol,
      title: markets.title,
      contractLabel: markets.contractLabel,
      yesBid: markets.yesBid,
      yesAsk: markets.yesAsk,
      lastPrice: markets.lastPrice,
    })
    .from(markets)
    .where(and(eq(markets.instrumentSymbol, instrumentSymbol), eq(markets.tracked, true)))
    .limit(1);
  if (!market) return null;

  const rows = await db
    .select({
      id: theses.id,
      side: theses.side,
      probabilityYes: theses.probabilityYes,
      entryPrice: theses.entryPrice,
      headline: theses.headline,
      body: theses.body,
      publishedAt: theses.publishedAt,
      authorId: authors.id,
      authorKind: authors.kind,
      authorName: authors.displayName,
    })
    .from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId))
    .where(and(eq(theses.marketId, market.id), inArray(theses.status, PUBLIC_THESIS_STATUSES)))
    .orderBy(sql`${theses.publishedAt} desc nulls last`, desc(theses.id));

  const records = await getAuthorRecords(db, [...new Set(rows.map((row) => row.authorId))]);
  const { id: _id, ...rest } = market;
  return {
    market: rest,
    theses: rows.map((row) => ({ ...row, record: records.get(row.authorId) ?? NO_RECORD })),
  };
}
