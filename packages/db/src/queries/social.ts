import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { authors, comments, likes, pricePoints, theses, trades, users } from '../schema';

/**
 * The social layer on a thesis: likes, comments and how many people copied it, plus the
 * short odds line each post in the feed shows.
 */

export interface SocialCounts {
  likes: number;
  comments: number;
  /** Copy trades that were filled. Rejected attempts are not copies. */
  copies: number;
  /** The viewer has liked it. False with no viewer. */
  liked: boolean;
}

const NONE: SocialCounts = { likes: 0, comments: 0, copies: 0, liked: false };

export async function getSocialCounts(
  db: Db,
  thesisIds: readonly string[],
  viewerUserId: string | null,
): Promise<Map<string, SocialCounts>> {
  const result = new Map<string, SocialCounts>();
  if (thesisIds.length === 0) return result;
  const ids = [...thesisIds];
  const [likeRows, commentRows, copyRows, mine] = await Promise.all([
    db.select({ thesisId: likes.thesisId, n: count() }).from(likes).where(inArray(likes.thesisId, ids)).groupBy(likes.thesisId),
    db
      .select({ thesisId: comments.thesisId, n: count() })
      .from(comments)
      .where(inArray(comments.thesisId, ids))
      .groupBy(comments.thesisId),
    db
      .select({ thesisId: trades.thesisId, n: count() })
      .from(trades)
      .where(
        and(
          inArray(trades.thesisId, ids),
          eq(trades.isAuthorPosition, false),
          inArray(trades.status, ['filled', 'partial', 'settled']),
        ),
      )
      .groupBy(trades.thesisId),
    viewerUserId
      ? db
          .select({ thesisId: likes.thesisId })
          .from(likes)
          .where(and(inArray(likes.thesisId, ids), eq(likes.userId, viewerUserId)))
      : Promise.resolve([] as Array<{ thesisId: string }>),
  ]);
  for (const id of ids) result.set(id, { ...NONE });
  for (const row of likeRows) result.get(row.thesisId)!.likes = row.n;
  for (const row of commentRows) result.get(row.thesisId)!.comments = row.n;
  for (const row of copyRows) if (row.thesisId) result.get(row.thesisId)!.copies = row.n;
  for (const row of mine) result.get(row.thesisId)!.liked = true;
  return result;
}

/** Likes or unlikes. Doing it twice is the same as doing it once. Returns the new state. */
export async function setLike(
  db: Db,
  thesisId: string,
  userId: string,
  liked: boolean,
): Promise<{ liked: boolean; likes: number }> {
  if (liked) await db.insert(likes).values({ thesisId, userId }).onConflictDoNothing();
  else await db.delete(likes).where(and(eq(likes.thesisId, thesisId), eq(likes.userId, userId)));
  const [row] = await db.select({ n: count() }).from(likes).where(eq(likes.thesisId, thesisId));
  return { liked, likes: row?.n ?? 0 };
}

export interface CommentRow {
  id: string;
  body: string;
  createdAt: Date;
  userId: string;
  displayName: string;
  /** Written by the thesis's own author. */
  byAuthor: boolean;
}

/** A thesis's comments, oldest first, so a conversation reads top to bottom. */
export async function listComments(db: Db, thesisId: string, limit = 200): Promise<CommentRow[]> {
  return db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      userId: comments.userId,
      displayName: users.displayName,
      byAuthor: sql<boolean>`coalesce(${authors.userId} = ${comments.userId}, false)`,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(theses, eq(theses.id, comments.thesisId))
    .innerJoin(authors, eq(authors.id, theses.authorId))
    .where(eq(comments.thesisId, thesisId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function addComment(db: Db, input: { thesisId: string; userId: string; body: string }): Promise<CommentRow> {
  const [row] = await db.insert(comments).values(input).returning({ id: comments.id });
  if (!row) throw new Error('addComment returned no row');
  const [view] = (await listComments(db, input.thesisId, 500)).filter((c) => c.id === row.id);
  if (!view) throw new Error('addComment could not read the comment back');
  return view;
}

/** How many comments a user has posted since a time, for a per-user daily cap. */
export async function countCommentsSince(db: Db, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(comments)
    .where(and(eq(comments.userId, userId), gte(comments.createdAt, since)));
  return row?.n ?? 0;
}

export interface SparkRequest {
  marketId: string;
  from: Date;
  to: Date;
}

export interface SparkPoint {
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
}

/**
 * A short price history for one market between two times, thinned to at most `buckets`
 * points: the window is cut into equal slices and the newest point in each is kept.
 */
export async function getSparkPoints(db: Db, request: SparkRequest, buckets = 48): Promise<SparkPoint[]> {
  const fromIso = request.from.toISOString();
  const seconds = Math.max((request.to.getTime() - request.from.getTime()) / 1000 / buckets, 0.001);
  const sliced = db
    .select({
      ts: pricePoints.ts,
      yesBid: pricePoints.yesBid,
      yesAsk: pricePoints.yesAsk,
      lastPrice: pricePoints.lastPrice,
      slice: sql<number>`least(
        floor(extract(epoch from (${pricePoints.ts} - ${fromIso}::timestamptz)) / ${seconds}::float8),
        ${buckets - 1}::float8
      )`.as('slice'),
    })
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.marketId, request.marketId),
        gte(pricePoints.ts, request.from),
        lte(pricePoints.ts, request.to),
      ),
    )
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
