import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { agentState, authors, markets, theses, tips, trades, users } from '../schema';
import { getAuthorRecords, type AuthorRecord, type AuthorRow, type UserRow } from './theses';

/**
 * Read models for the public record: the leaderboard, author profiles, the strip of recent
 * payouts and refunds, and a user's own account page. Everything here is derived from
 * resolved theses and settled trades; nothing is stored twice.
 */

const NO_RECORD: AuthorRecord = { resolved: 0, right: 0, brier: null, marketBrier: null };

export interface AuthorStanding {
  author: AuthorRow;
  record: AuthorRecord;
  /** Payout minus cost over the author's own settled positions, in test dollars. */
  profitUsd: string;
  /** Public theses in total, resolved or not. */
  theses: number;
}

/** Profit and thesis count per author, for the authors given (or all, when none are). */
async function standings(db: Db, authorIds?: readonly string[]): Promise<AuthorStanding[]> {
  const profit = db
    .select({
      authorId: theses.authorId,
      profit: sql<string>`coalesce(sum(${trades.payoutUsd} - ${trades.costUsd}), 0)`.as('profit'),
    })
    .from(trades)
    .innerJoin(theses, eq(theses.id, trades.thesisId))
    .where(and(eq(trades.isAuthorPosition, true), eq(trades.status, 'settled')))
    .groupBy(theses.authorId)
    .as('profit');
  const counts = db
    .select({ authorId: theses.authorId, total: sql<number>`count(*)::int`.as('total') })
    .from(theses)
    .where(inArray(theses.status, ['published', 'resolved']))
    .groupBy(theses.authorId)
    .as('counts');

  const rows = await db
    .select({
      author: authors,
      profitUsd: sql<string>`coalesce(${profit.profit}, 0)::numeric(16,4)::text`,
      theses: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
    })
    .from(authors)
    .innerJoin(counts, eq(counts.authorId, authors.id))
    .leftJoin(profit, eq(profit.authorId, authors.id))
    .where(authorIds ? inArray(authors.id, [...authorIds]) : undefined);

  const records = await getAuthorRecords(db, rows.map((row) => row.author.id));
  return rows.map((row) => ({ ...row, record: records.get(row.author.id) ?? NO_RECORD }));
}

/** Every author with at least one public thesis. The caller ranks them. */
export function getLeaderboard(db: Db): Promise<AuthorStanding[]> {
  return standings(db);
}

export interface AgentStatus {
  halted: boolean;
  haltReason: string | null;
  tradesToday: number;
  realizedPnlTodayUsd: string;
  openExposureUsd: string;
}

/** One author's standing, and for an agent how its day is going. Null if there is no such author. */
export async function getAuthorStanding(
  db: Db,
  authorId: string,
  now: Date,
): Promise<(AuthorStanding & { agentStatus: AgentStatus | null }) | null> {
  const [author] = await db.select().from(authors).where(eq(authors.id, authorId)).limit(1);
  if (!author) return null;
  const [standing] = await standings(db, [authorId]);
  const records = standing ? null : await getAuthorRecords(db, [authorId]);
  const base: AuthorStanding = standing ?? {
    author,
    record: records?.get(authorId) ?? NO_RECORD,
    profitUsd: '0.0000',
    theses: 0,
  };
  let agentStatus: AgentStatus | null = null;
  if (author.agentKey) {
    const [state] = await db
      .select()
      .from(agentState)
      .where(and(eq(agentState.agentKey, author.agentKey), eq(agentState.day, now.toISOString().slice(0, 10))));
    agentStatus = {
      halted: state?.halted ?? false,
      haltReason: state?.haltReason ?? null,
      tradesToday: state?.tradeCount ?? 0,
      realizedPnlTodayUsd: state?.realizedPnlUsd ?? '0.0000',
      openExposureUsd: state?.openExposureUsd ?? '0.0000',
    };
  }
  return { ...base, agentStatus };
}

export interface ActivityItem {
  tipId: string;
  status: 'paid' | 'refunded';
  amountUsdc: string;
  settleTx: string | null;
  thesisId: string;
  headline: string;
  outcome: 'right' | 'wrong' | 'void' | null;
  authorName: string;
  marketTitle: string;
  at: Date;
}

/** The latest tips paid to authors or returned to tippers, newest first, for the live strip. */
export async function getActivity(db: Db, limit = 10): Promise<ActivityItem[]> {
  return db
    .select({
      tipId: tips.id,
      status: sql<'paid' | 'refunded'>`${tips.status}`,
      amountUsdc: tips.amountUsdc,
      settleTx: tips.settleTx,
      thesisId: theses.id,
      headline: theses.headline,
      outcome: theses.outcome,
      authorName: authors.displayName,
      marketTitle: markets.title,
      at: sql<Date>`coalesce(${markets.resolvedAt}, ${tips.createdAt})`.mapWith(tips.createdAt),
    })
    .from(tips)
    .innerJoin(theses, eq(theses.id, tips.thesisId))
    .innerJoin(authors, eq(authors.id, theses.authorId))
    .innerJoin(markets, eq(markets.id, theses.marketId))
    .where(inArray(tips.status, ['paid', 'refunded']))
    .orderBy(sql`coalesce(${markets.resolvedAt}, ${tips.createdAt}) desc`, desc(tips.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
}

export interface PositionRow {
  tradeId: string;
  thesisId: string | null;
  headline: string | null;
  marketSymbol: string;
  marketTitle: string;
  contractLabel: string | null;
  expiryAt: Date | null;
  isAuthorPosition: boolean;
  side: 'yes' | 'no';
  quantity: string;
  price: string;
  costUsd: string;
  payoutUsd: string | null;
  status: string;
  createdAt: Date;
}

export interface TipRow {
  tipId: string;
  thesisId: string;
  headline: string;
  amountUsdc: string;
  status: 'pending' | 'escrowed' | 'paid' | 'refunded' | 'failed';
  depositTx: string | null;
  settleTx: string | null;
  createdAt: Date;
}

/** A user's positions (their own theses' and their copies) and their tips, newest first. */
export async function getAccount(db: Db, userId: string): Promise<{ positions: PositionRow[]; tips: TipRow[] }> {
  const [positions, tipRows] = await Promise.all([
    db
      .select({
        tradeId: trades.id,
        thesisId: trades.thesisId,
        headline: theses.headline,
        marketSymbol: markets.instrumentSymbol,
        marketTitle: markets.title,
        contractLabel: markets.contractLabel,
        expiryAt: markets.expiryAt,
        isAuthorPosition: trades.isAuthorPosition,
        side: trades.side,
        quantity: trades.quantity,
        price: trades.price,
        costUsd: trades.costUsd,
        payoutUsd: trades.payoutUsd,
        status: sql<string>`${trades.status}`,
        createdAt: trades.createdAt,
      })
      .from(trades)
      .innerJoin(markets, eq(markets.id, trades.marketId))
      .leftJoin(theses, eq(theses.id, trades.thesisId))
      .where(and(eq(trades.userId, userId), inArray(trades.status, ['filled', 'partial', 'settled'])))
      .orderBy(desc(trades.createdAt))
      .limit(100),
    db
      .select({
        tipId: tips.id,
        thesisId: tips.thesisId,
        headline: theses.headline,
        amountUsdc: tips.amountUsdc,
        status: tips.status,
        depositTx: tips.depositTx,
        settleTx: tips.settleTx,
        createdAt: tips.createdAt,
      })
      .from(tips)
      .innerJoin(theses, eq(theses.id, tips.thesisId))
      .where(eq(tips.userId, userId))
      .orderBy(desc(tips.createdAt))
      .limit(100),
  ]);
  return { positions, tips: tipRows };
}

export interface PendingLimits {
  maxPerTradeUsd?: string;
  dailyCopyCapUsd?: string;
  /** The UTC day, YYYY-MM-DD, from which the raise applies. */
  effectiveOn: string;
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const cents = (value: string) => Math.round(Number(value) * 100);

/**
 * Applies a raise that was requested on an earlier day and has now come due. Returns the
 * user as they stand after it.
 */
export async function applyDueLimits(db: Db, user: UserRow, now: Date): Promise<UserRow> {
  const pending = user.pendingLimits;
  if (!pending || pending.effectiveOn > utcDay(now)) return user;
  const [updated] = await db
    .update(users)
    .set({
      ...(pending.maxPerTradeUsd ? { maxPerTradeUsd: pending.maxPerTradeUsd } : {}),
      ...(pending.dailyCopyCapUsd ? { dailyCopyCapUsd: pending.dailyCopyCapUsd } : {}),
      pendingLimits: null,
    })
    .where(eq(users.id, user.id))
    .returning();
  return updated ?? user;
}

/**
 * Changes a user's limits. Lowering one applies at once. Raising one applies from the next
 * UTC day, so a decision made in the heat of a trade cannot loosen today's limits.
 */
export async function requestLimits(
  db: Db,
  user: UserRow,
  wanted: { maxPerTradeUsd?: string; dailyCopyCapUsd?: string },
  now: Date,
): Promise<UserRow> {
  const immediate: { maxPerTradeUsd?: string; dailyCopyCapUsd?: string } = {};
  const tomorrow = utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const pending: PendingLimits = { ...(user.pendingLimits ?? {}), effectiveOn: tomorrow };

  for (const key of ['maxPerTradeUsd', 'dailyCopyCapUsd'] as const) {
    const value = wanted[key];
    if (value === undefined) continue;
    if (cents(value) <= cents(user[key])) {
      immediate[key] = value;
      // A lower limit also withdraws any raise waiting for tomorrow.
      delete pending[key];
    } else {
      pending[key] = value;
    }
  }
  const hasPending = pending.maxPerTradeUsd !== undefined || pending.dailyCopyCapUsd !== undefined;
  const [updated] = await db
    .update(users)
    .set({ ...immediate, pendingLimits: hasPending ? pending : null })
    .where(eq(users.id, user.id))
    .returning();
  return updated ?? user;
}
