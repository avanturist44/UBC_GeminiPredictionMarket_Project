import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  audits,
  authors,
  llmCalls,
  markets,
  theses,
  tips,
  trades,
  users,
  type AuditClaim,
  type Evidence,
} from '../schema';

/** Users, authors, thesis submission, and the read models behind the feeds and thesis page. */

export type UserRow = typeof users.$inferSelect;
export type AuthorRow = typeof authors.$inferSelect;
export type ThesisRow = typeof theses.$inferSelect;
export type MarketRecord = typeof markets.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type AuditRow = typeof audits.$inferSelect;

/** A thesis counts as public once it is published, and stays public after it resolves. */
const PUBLIC_STATUSES = ['published', 'resolved'] as const;

export async function createGuestUser(db: Db, displayName: string): Promise<UserRow> {
  const [user] = await db.insert(users).values({ displayName, isGuest: true }).returning();
  if (!user) throw new Error('createGuestUser returned no row');
  return user;
}

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

/** The author record for a person, created the first time they publish. */
export async function ensureHumanAuthor(db: Db, user: Pick<UserRow, 'id' | 'displayName'>): Promise<AuthorRow> {
  await db
    .insert(authors)
    .values({ kind: 'human', userId: user.id, displayName: user.displayName })
    .onConflictDoNothing();
  const [author] = await db.select().from(authors).where(eq(authors.userId, user.id)).limit(1);
  if (!author) throw new Error('ensureHumanAuthor found no author');
  return author;
}

/** The author record for an agent, created the first time it runs. */
export async function ensureAgentAuthor(
  db: Db,
  agent: { agentKey: string; displayName: string; strategySummary: string },
): Promise<AuthorRow> {
  await db.insert(authors).values({ kind: 'agent', ...agent }).onConflictDoNothing();
  const [author] = await db.select().from(authors).where(eq(authors.agentKey, agent.agentKey)).limit(1);
  if (!author) throw new Error('ensureAgentAuthor found no author');
  return author;
}

export async function getMarketBySymbol(db: Db, instrumentSymbol: string): Promise<MarketRecord | null> {
  const [market] = await db
    .select()
    .from(markets)
    .where(and(eq(markets.instrumentSymbol, instrumentSymbol), eq(markets.tracked, true)))
    .limit(1);
  return market ?? null;
}

/** True when the author already has a thesis on this market that is live or being audited. */
export async function hasOpenThesis(db: Db, authorId: string, marketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: theses.id })
    .from(theses)
    .where(
      and(
        eq(theses.authorId, authorId),
        eq(theses.marketId, marketId),
        inArray(theses.status, ['auditing', 'published', 'resolved']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** How many of an author's theses are waiting on the auditor. */
export async function countAuditingTheses(db: Db, authorId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(theses)
    .where(and(eq(theses.authorId, authorId), eq(theses.status, 'auditing')));
  return row?.count ?? 0;
}

/** How many theses an author has submitted since `since`, whatever became of them. */
export async function countThesesSince(db: Db, authorId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(theses)
    .where(and(eq(theses.authorId, authorId), sql`${theses.createdAt} >= ${since.toISOString()}::timestamptz`));
  return row?.count ?? 0;
}

export interface NewThesis {
  id: string;
  onchainId: string;
  contentHash: string;
  authorId: string;
  /** Set for a person. Agents have no user. */
  userId: string | null;
  marketId: string;
  side: 'yes' | 'no';
  probabilityYes: string;
  headline: string;
  body: string;
  evidence: Evidence[];
  /** The author's intended position: the most they will pay per contract, and how much. */
  limitPrice: string;
  quantity: string;
  stakeUsd: string;
}

/** The idempotency key of a thesis's author trade. One per thesis, so a retry cannot double it. */
export const authorTradeKey = (thesisId: string) => `thesis:${thesisId}:author`;

/**
 * Stores a thesis as `auditing` together with its author's intended trade as `pending`.
 * Nothing is charged here: the trade is filled, or rejected, after the audit. Writing the
 * intent first means a crash between the two steps leaves a visible trail.
 */
export async function createAuditingThesis(db: Db, thesis: NewThesis): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(theses).values({
      id: thesis.id,
      onchainId: thesis.onchainId,
      contentHash: thesis.contentHash,
      authorId: thesis.authorId,
      marketId: thesis.marketId,
      side: thesis.side,
      probabilityYes: thesis.probabilityYes,
      headline: thesis.headline,
      body: thesis.body,
      evidence: thesis.evidence,
      status: 'auditing',
    });
    await tx.insert(trades).values({
      userId: thesis.userId,
      authorId: thesis.authorId,
      marketId: thesis.marketId,
      thesisId: thesis.id,
      isAuthorPosition: true,
      side: thesis.side,
      quantity: thesis.quantity,
      price: thesis.limitPrice,
      costUsd: thesis.stakeUsd,
      mode: 'paper',
      status: 'pending',
      locked: true,
      idempotencyKey: authorTradeKey(thesis.id),
    });
  });
}

/** One model call's row. `costUsd` is what it cost in US dollars, as a decimal string. */
export async function recordLlmCall(
  db: Db,
  call: { purpose: string; model: string; inputTokens: number; outputTokens: number; costUsd: string },
): Promise<void> {
  await db.insert(llmCalls).values(call);
}

/**
 * Which model calls a sum counts, by purpose: with `purposePrefix`, only calls whose purpose starts
 * with it (or with any one of a list); with `excludePrefix`, none whose purpose starts with it (or
 * with any one of a list).
 */
export interface PurposeScope {
  purposePrefix?: string | readonly string[];
  excludePrefix?: string | readonly string[];
}

/** Matches `prefix` literally in a SQL `like`: `%`, `_` and the escape character are escaped. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
const listOf = (prefixes: string | readonly string[]) => (typeof prefixes === 'string' ? [prefixes] : prefixes);

/** The calls since `since` that `scope` counts. */
function callsIn(since: Date, scope: PurposeScope) {
  const conditions = [sql`${llmCalls.createdAt} >= ${since.toISOString()}::timestamptz`];
  if (scope.purposePrefix !== undefined) {
    const matches = listOf(scope.purposePrefix).map((prefix) => sql`${llmCalls.purpose} like ${likePrefix(prefix)} escape '\\'`);
    // An empty list matches nothing.
    conditions.push(or(...matches) ?? sql`false`);
  }
  for (const prefix of scope.excludePrefix === undefined ? [] : listOf(scope.excludePrefix)) {
    conditions.push(sql`${llmCalls.purpose} not like ${likePrefix(prefix)} escape '\\'`);
  }
  return and(...conditions);
}

/** US dollars spent on model calls since `since`: whatever they were for, or those in `scope`. */
export async function llmCostSince(db: Db, since: Date, scope: PurposeScope = {}): Promise<number> {
  const [row] = await db
    .select({ cost: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text` })
    .from(llmCalls)
    .where(callsIn(since, scope));
  return Number(row?.cost ?? 0);
}

/** Tokens used, input plus output, by model calls since `since`: every call, or those in `scope`. */
export async function llmTokensSince(db: Db, since: Date, scope: PurposeScope = {}): Promise<number> {
  const [row] = await db
    .select({
      tokens: sql<number>`coalesce(sum(${llmCalls.inputTokens} + ${llmCalls.outputTokens}), 0)::int`,
    })
    .from(llmCalls)
    .where(callsIn(since, scope));
  return row?.tokens ?? 0;
}

/** An author's track record, from resolved theses only. Void outcomes do not count. */
export interface AuthorRecord {
  resolved: number;
  right: number;
  /** Mean of (probability of YES minus the outcome) squared. Lower is better; 0.25 is a coin flip. */
  brier: number | null;
  /** The market price's own score on the same theses, to show whether the author beat the price. */
  marketBrier: number | null;
}

const NO_RECORD: AuthorRecord = { resolved: 0, right: 0, brier: null, marketBrier: null };

export async function getAuthorRecords(db: Db, authorIds: readonly string[]): Promise<Map<string, AuthorRecord>> {
  const records = new Map<string, AuthorRecord>();
  if (authorIds.length === 0) return records;
  // 1 if YES won. The thesis was right exactly when its side matches the winner.
  const yesWon = sql`(case when (${theses.side} = 'yes') = (${theses.outcome} = 'right') then 1 else 0 end)`;
  const rows = await db
    .select({
      authorId: theses.authorId,
      resolved: sql<number>`count(*)::int`,
      right: sql<number>`(count(*) filter (where ${theses.outcome} = 'right'))::int`,
      brier: sql<string | null>`avg(power(${theses.probabilityYes} - ${yesWon}, 2))`,
      marketBrier: sql<string | null>`avg(power(${theses.marketYesPriceAtPublish} - ${yesWon}, 2))`,
    })
    .from(theses)
    .where(
      and(
        inArray(theses.authorId, [...authorIds]),
        eq(theses.status, 'resolved'),
        inArray(theses.outcome, ['right', 'wrong']),
      ),
    )
    .groupBy(theses.authorId);
  const round = (value: string | null) => (value === null ? null : Math.round(Number(value) * 10_000) / 10_000);
  for (const row of rows) {
    records.set(row.authorId, {
      resolved: row.resolved,
      right: row.right,
      brier: round(row.brier),
      marketBrier: round(row.marketBrier),
    });
  }
  return records;
}

export interface ThesisView {
  thesis: ThesisRow;
  author: AuthorRow;
  record: AuthorRecord;
  market: MarketRecord;
  /** The newest audit, or null if the thesis has not been audited. */
  audit: AuditRow | null;
  /** The author's own position. Null for a thesis whose trade row is missing. */
  position: TradeRow | null;
  /** Test USDC from copiers sitting in escrow or already paid out. */
  tipsUsdc: string;
}

function latestAudits(db: Db) {
  return db
    .selectDistinctOn([audits.thesisId])
    .from(audits)
    .orderBy(audits.thesisId, desc(audits.createdAt))
    .as('latest_audit');
}

async function loadViews(
  db: Db,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<ThesisView[]> {
  const audit = latestAudits(db);
  const tipTotals = db
    .select({
      thesisId: tips.thesisId,
      total: sql<string>`sum(${tips.amountUsdc})`.as('tips_total'),
    })
    .from(tips)
    .where(inArray(tips.status, ['escrowed', 'paid']))
    .groupBy(tips.thesisId)
    .as('tip_totals');

  const rows = await db
    .select({
      thesis: theses,
      author: authors,
      market: markets,
      audit: {
        id: audit.id,
        thesisId: audit.thesisId,
        verdict: audit.verdict,
        claims: audit.claims,
        insideInfo: audit.insideInfo,
        blockReason: audit.blockReason,
        model: audit.model,
        createdAt: audit.createdAt,
      },
      position: trades,
      tipsUsdc: sql<string>`coalesce(${tipTotals.total}, 0)::text`,
    })
    .from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId))
    .innerJoin(markets, eq(markets.id, theses.marketId))
    .leftJoin(audit, eq(audit.thesisId, theses.id))
    .leftJoin(
      trades,
      and(eq(trades.thesisId, theses.id), eq(trades.isAuthorPosition, true), sql`${trades.status} <> 'rejected'`),
    )
    .leftJoin(tipTotals, eq(tipTotals.thesisId, theses.id))
    .where(where)
    .orderBy(sql`${theses.publishedAt} desc nulls first`, desc(theses.createdAt), desc(theses.id))
    .limit(limit);

  const records = await getAuthorRecords(db, [...new Set(rows.map((row) => row.author.id))]);
  return rows.map((row) => ({
    thesis: row.thesis,
    author: row.author,
    record: records.get(row.author.id) ?? NO_RECORD,
    market: row.market,
    // With no audit, the left join yields null, or an object of nulls.
    audit: row.audit && row.audit.id !== null ? (row.audit as AuditRow) : null,
    position: row.position,
    tipsUsdc: row.tipsUsdc,
  }));
}

export interface FeedOptions {
  /** Whose theses: agents, people, or both. */
  kind: 'agent' | 'human' | 'all';
  /** Only this agent's theses. */
  agentKey?: string;
  /** Return theses published before this time: the `publishedAt` of the last one already shown. */
  before?: Date;
  limit?: number;
}

/** Public theses, newest first: from agents, from people, or from both. */
export async function getFeed(db: Db, options: FeedOptions): Promise<ThesisView[]> {
  return loadViews(
    db,
    and(
      inArray(theses.status, PUBLIC_STATUSES),
      options.kind === 'all' ? undefined : eq(authors.kind, options.kind),
      options.agentKey ? eq(authors.agentKey, options.agentKey) : undefined,
      options.before ? lt(theses.publishedAt, options.before) : undefined,
    ),
    Math.min(Math.max(options.limit ?? 20, 1), 50),
  );
}

/** One author's public theses, newest first, for their profile. */
export async function getAuthorTheses(db: Db, authorId: string, limit = 50): Promise<ThesisView[]> {
  return loadViews(
    db,
    and(inArray(theses.status, PUBLIC_STATUSES), eq(theses.authorId, authorId)),
    Math.min(Math.max(limit, 1), 100),
  );
}

/** One thesis in any status. The caller decides who may see one that is not public. */
export async function getThesisView(db: Db, thesisId: string): Promise<ThesisView | null> {
  const [view] = await loadViews(db, and(eq(theses.id, thesisId)), 1);
  return view ?? null;
}

export function isPublicThesis(thesis: Pick<ThesisRow, 'status'>): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(thesis.status);
}

/** The agents that have published, for the feed's filter. */
export async function listAgentAuthors(db: Db): Promise<Array<{ agentKey: string; displayName: string }>> {
  const rows = await db
    .select({ agentKey: authors.agentKey, displayName: authors.displayName })
    .from(authors)
    .where(eq(authors.kind, 'agent'))
    .orderBy(authors.displayName);
  return rows.filter((row): row is { agentKey: string; displayName: string } => row.agentKey !== null);
}

export type { AuditClaim, Evidence };
