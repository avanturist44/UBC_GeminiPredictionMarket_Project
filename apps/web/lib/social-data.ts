import 'server-only';
import { COMMENTS_PER_DAY, checkComment } from '@thesis/core';
import {
  addComment,
  authors,
  countCommentsSince,
  eq,
  isPublicThesis,
  listComments,
  setLike,
  theses,
  type CommentRow,
  type UserRow,
} from '@thesis/db';
import { z } from 'zod';
import { getDb } from './db';
import type { Loaded } from './market-data';
import { NOT_CONFIGURED, UUID, dbError } from './thesis-data';
import type { CommentView, CommentsResponse, LikeResponse } from './thesis-view';

/** Likes and comments on a thesis. Only published or resolved theses can be liked or commented on. */

const NOT_FOUND: Loaded<never> = {
  ok: false,
  status: 404,
  error: { code: 'not_found', message: 'There is no published thesis at this address.' },
};

async function publicThesis(id: string): Promise<{ authorUserId: string | null } | null> {
  const db = getDb();
  if (!db || !UUID.test(id)) return null;
  const [row] = await db
    .select({ status: theses.status, authorUserId: authors.userId })
    .from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId))
    .where(eq(theses.id, id))
    .limit(1);
  return row && isPublicThesis(row) ? { authorUserId: row.authorUserId } : null;
}

const LikeBody = z.object({ liked: z.boolean() });

export async function changeLike(user: UserRow, thesisId: string, body: unknown): Promise<Loaded<LikeResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  const parsed = LikeBody.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: { code: 'invalid', message: 'Send { "liked": true } or false.' } };
  try {
    const thesis = await publicThesis(thesisId);
    if (!thesis) return NOT_FOUND;
    // The same rule as tips: nobody inflates their own thesis.
    if (thesis.authorUserId === user.id) {
      return { ok: false, status: 409, error: { code: 'own_thesis', message: 'You cannot like your own thesis.' } };
    }
    return { ok: true, data: await setLike(db, thesisId, user.id, parsed.data.liked) };
  } catch (error) {
    return dbError(error);
  }
}

const toView = (row: CommentRow, viewerId: string | null): CommentView => ({
  id: row.id,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
  displayName: row.displayName,
  byAuthor: row.byAuthor,
  byViewer: viewerId !== null && row.userId === viewerId,
});

export async function loadComments(thesisId: string, viewer: UserRow | null): Promise<Loaded<CommentsResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    if (!(await publicThesis(thesisId))) return NOT_FOUND;
    const rows = await listComments(db, thesisId);
    return {
      ok: true,
      data: { asOf: new Date().toISOString(), comments: rows.map((row) => toView(row, viewer?.id ?? null)) },
    };
  } catch (error) {
    return dbError(error);
  }
}

export async function postComment(
  user: UserRow,
  thesisId: string,
  body: unknown,
  now: Date,
): Promise<Loaded<CommentView>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  const checked = checkComment(body);
  if (!checked.ok) return { ok: false, status: 400, error: { code: checked.code, message: checked.message } };
  try {
    if (!(await publicThesis(thesisId))) return NOT_FOUND;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if ((await countCommentsSince(db, user.id, today)) >= COMMENTS_PER_DAY) {
      return {
        ok: false,
        status: 429,
        error: { code: 'comment_cap', message: `You can post ${COMMENTS_PER_DAY} comments a day. Try again tomorrow (UTC).` },
      };
    }
    const row = await addComment(db, { thesisId, userId: user.id, body: checked.body });
    return { ok: true, data: toView(row, user.id) };
  } catch (error) {
    return dbError(error);
  }
}
