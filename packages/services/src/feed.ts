import { z } from 'zod';
import { and, audits, authors, desc, eq, inArray, markets, sql, theses, thesisJobs, trades, type Db } from '@thesis/db';
import { publicSource } from './audit';
import { PublicationError } from './publication';

const Cursor = z.strictObject({ at: z.string().datetime(), id: z.string().uuid() });
export const FeedQuery = z.object({ kind: z.enum(['agent', 'human']), agent: z.enum(['momentum', 'news', 'fade']).optional(), cursor: z.string().max(300).optional() });
type Thesis = typeof theses.$inferSelect;
type Author = typeof authors.$inferSelect;
type Market = typeof markets.$inferSelect;
type Audit = typeof audits.$inferSelect;
type Trade = typeof trades.$inferSelect;
type Job = typeof thesisJobs.$inferSelect;
export function toThesisView(thesis: Thesis, author: Author, market: Market, audit?: Audit, trade?: Trade, job?: Job) {
  return { id: thesis.id, headline: thesis.headline, body: thesis.body, side: thesis.side,
    probabilityYes: thesis.probabilityYes, status: thesis.status, outcome: thesis.outcome,
    publishedAt: thesis.publishedAt?.toISOString() ?? null,
    author: { id: author.id, name: author.displayName, kind: author.kind, agentKey: author.agentKey },
    market: { title: market.title, symbol: market.instrumentSymbol, yesBid: market.yesBid, yesAsk: market.yesAsk,
      expiryAt: market.expiryAt?.toISOString() ?? null, updatedAt: market.updatedAt.toISOString() },
    evidence: thesis.evidence.flatMap(item => { const url = publicSource(item.url); return url ? [{ claim: item.claim.slice(0, 500), url }] : []; }),
    entryPrice: thesis.entryPrice, contentHash: thesis.contentHash,
    registerTx: thesis.registerTx && /^0x[0-9a-fA-F]{64}$/.test(thesis.registerTx) ? thesis.registerTx : null,
    audit: audit ? { verdict: audit.verdict, insideInfo: audit.insideInfo, model: audit.model,
      at: audit.createdAt.toISOString(), claims: audit.claims.map(claim => ({ ...claim,
        source_url: claim.source_url ? publicSource(claim.source_url) : null })) } : null,
    position: trade ? { side: trade.side, quantity: trade.quantity, price: trade.price, costUsd: trade.costUsd,
      status: trade.status, payoutUsd: trade.payoutUsd, mode: trade.mode, locked: trade.locked } : null,
    // Queue state is supplied only to the owner of an unpublished thesis.
    publication: job ? { status: job.status, errorCode: job.errorCode, stakeUsd: job.stakeUsd } : null,
  };
}
export type ThesisView = ReturnType<typeof toThesisView>;
export type FeedResponse = { asOf: string; theses: ThesisView[]; nextCursor: string | null };
async function enrich(db: Db, rows: { thesis: Thesis; author: Author; market: Market }[]) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.thesis.id);
  const [checks, positions] = await Promise.all([
    db.select().from(audits).where(inArray(audits.thesisId, ids)).orderBy(desc(audits.createdAt), desc(audits.id)),
    db.select().from(trades).where(and(inArray(trades.thesisId, ids), eq(trades.isAuthorPosition, true),
      inArray(trades.status, ['filled', 'partial', 'settled']))),
  ]);
  return rows.map(({ thesis, author, market }) => toThesisView(thesis, author, market,
    checks.find(check => check.thesisId === thesis.id), positions.find(trade => trade.thesisId === thesis.id)));
}
export async function listThesisFeed(db: Db, input: unknown): Promise<FeedResponse> {
  const query = FeedQuery.parse(input);
  let cursor: z.infer<typeof Cursor> | undefined;
  if (query.cursor) {
    try { cursor = Cursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); }
    catch { throw new PublicationError('invalid_cursor', 400); }
  }
  const rows = await db.select({ thesis: theses, author: authors, market: markets }).from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .where(and(eq(authors.kind, query.kind), inArray(theses.status, ['published', 'resolved']),
      query.agent ? eq(authors.agentKey, query.agent) : undefined,
      cursor ? sql`(${theses.publishedAt}, ${theses.id}) < (${new Date(cursor.at)}, ${cursor.id}::uuid)` : undefined))
    .orderBy(desc(theses.publishedAt), desc(theses.id)).limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1)?.thesis;
  return { asOf: new Date().toISOString(), theses: await enrich(db, page),
    nextCursor: rows.length > 20 && last?.publishedAt ? Buffer.from(JSON.stringify({ at: last.publishedAt.toISOString(), id: last.id })).toString('base64url') : null };
}
export async function getThesisView(db: Db, id: string, viewerUserId?: string | null) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await db.select({ thesis: theses, author: authors, market: markets }).from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .where(eq(theses.id, id));
  if (!row) return null;
  const isPublic = ['published', 'resolved'].includes(row.thesis.status);
  if (!isPublic && (!viewerUserId || row.author.userId !== viewerUserId)) return null;
  const [view] = await enrich(db, [row]);
  if (!isPublic) {
    const [job] = await db.select().from(thesisJobs).where(eq(thesisJobs.thesisId, id));
    if (job) view!.publication = { status: job.status, errorCode: job.errorCode, stakeUsd: job.stakeUsd };
  }
  return view!;
}
