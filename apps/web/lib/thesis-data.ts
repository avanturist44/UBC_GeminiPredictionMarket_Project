import 'server-only';
import { and, desc, eq, getFeed, getThesisView, isPublicThesis, listAgentAuthors, trades, type UserRow } from '@thesis/db';
import { copiedSince } from './copy-trade';
import { getDb } from './db';
import type { Loaded } from './market-data';
import { toThesisCard, toThesisDetail } from './thesis-mapping';
import { readTipBalance } from './tip-balance';
import type { FeedResponse, MeResponse, ThesisResponse } from './thesis-view';

/** Loads what the feeds and the thesis page send. Pages and API routes share it. */

export const NOT_CONFIGURED: Loaded<never> = {
  ok: false,
  status: 503,
  error: { code: 'not_configured', message: 'No database is connected.' },
};
const NOT_FOUND: Loaded<never> = {
  ok: false,
  status: 404,
  error: { code: 'not_found', message: 'There is no thesis at this address.' },
};

export function dbError(error: unknown): Loaded<never> {
  console.error('thesis query failed', error);
  return {
    ok: false,
    status: 503,
    error: { code: 'db_error', message: 'Theses could not be read. Try again in a moment.' },
  };
}

const PAGE = 20;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadFeed(
  kind: 'agent' | 'human',
  options: { agentKey?: string; cursor?: string } = {},
): Promise<Loaded<FeedResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  const before = options.cursor ? new Date(options.cursor) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    return { ok: false, status: 400, error: { code: 'invalid', message: 'The cursor is not a time.' } };
  }
  const agentKey = options.agentKey && /^[a-z0-9_-]{1,40}$/i.test(options.agentKey) ? options.agentKey : undefined;
  try {
    const [views, agents] = await Promise.all([
      getFeed(db, { kind, agentKey, before, limit: PAGE }),
      kind === 'agent' ? listAgentAuthors(db) : Promise.resolve([]),
    ]);
    const last = views.at(-1);
    return {
      ok: true,
      data: {
        asOf: new Date().toISOString(),
        kind,
        theses: views.map(toThesisCard),
        nextCursor: views.length === PAGE && last?.thesis.publishedAt ? last.thesis.publishedAt.toISOString() : null,
        agents,
      },
    };
  } catch (error) {
    return dbError(error);
  }
}

/** A public thesis for anyone; one still being audited, blocked or sent back for its author only. */
export async function loadThesis(id: string, viewer: UserRow | null): Promise<Loaded<ThesisResponse>> {
  if (!UUID.test(id)) return NOT_FOUND;
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const view = await getThesisView(db, id);
    if (!view) return NOT_FOUND;
    const isAuthor = viewer !== null && view.author.userId === viewer.id;
    if (!isPublicThesis(view.thesis) && !isAuthor) return NOT_FOUND;

    let rejectReason: string | null = null;
    if (isAuthor && view.thesis.status === 'draft') {
      const [rejected] = await db
        .select({ reason: trades.rejectReason })
        .from(trades)
        .where(and(eq(trades.thesisId, id), eq(trades.isAuthorPosition, true), eq(trades.status, 'rejected')))
        .orderBy(desc(trades.createdAt))
        .limit(1);
      rejectReason = rejected?.reason ?? 'The trade could not be placed. Nothing was charged.';
    }
    return {
      ok: true,
      data: {
        asOf: new Date().toISOString(),
        thesis: toThesisDetail(view, { userId: viewer?.id ?? null, rejectReason }),
      },
    };
  } catch (error) {
    return dbError(error);
  }
}

export async function toMe(user: UserRow): Promise<MeResponse> {
  const db = getDb();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [copiedTodayUsd, tipBalanceUsdc] = await Promise.all([
    db ? copiedSince(db, user.id, today) : '0.0000',
    readTipBalance(user.walletAddress),
  ]);
  return {
    id: user.id,
    displayName: user.displayName,
    paperBalanceUsd: user.paperBalanceUsd,
    maxPerTradeUsd: user.maxPerTradeUsd,
    dailyCopyCapUsd: user.dailyCopyCapUsd,
    copiedTodayUsd,
    pendingLimits: user.pendingLimits ?? null,
    walletAddress: user.walletAddress,
    tipBalanceUsdc,
  };
}
