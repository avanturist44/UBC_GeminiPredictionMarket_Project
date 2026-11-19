import { z } from 'zod';
import { and, authors, desc, eq, inArray, markets, sql, theses, tips, trades, type Db } from '@thesis/db';
import { units } from './money';
const scored = sql`${theses.status} = 'resolved' and ${theses.outcome} in ('right','wrong') and ${markets.resolutionSide} in ('yes','no') and ${markets.status} <> 'invalid'`;
/** Aggregate before ranking; author positions only, with no joins to copies, tips or audits that multiply rows. */
export async function authorRecords(db: Db, ids?: string[]) {
  if (ids && !ids.length) return [];
  const positions = db.select({ thesisId: trades.thesisId,
    profit: sql<string>`coalesce(sum(${trades.payoutUsd} - ${trades.costUsd}) filter (where ${trades.status} = 'settled' and ${trades.mode} = 'paper'), 0)`.as('profit'),
  }).from(trades).where(eq(trades.isAuthorPosition, true)).groupBy(trades.thesisId).as('author_positions');
  return db.select({ id: authors.id, name: authors.displayName, kind: authors.kind, agentKey: authors.agentKey,
    summary: authors.strategySummary, isTest: authors.isTest,
    published: sql<number>`count(${theses.id})::int`.mapWith(Number),
    resolved: sql<number>`count(*) filter (where ${scored})::int`.mapWith(Number),
    right: sql<number>`count(*) filter (where ${scored} and ${theses.outcome} = 'right')::int`.mapWith(Number),
    voided: sql<number>`count(*) filter (where ${theses.status} = 'resolved' and ${theses.outcome} = 'void')::int`.mapWith(Number),
    brier: sql<string | null>`avg(power(${theses.probabilityYes} - case when ${markets.resolutionSide} = 'yes' then 1 else 0 end, 2)) filter (where ${scored})::text`,
    marketBrier: sql<string | null>`avg(power(${theses.marketYesPriceAtPublish} - case when ${markets.resolutionSide} = 'yes' then 1 else 0 end, 2)) filter (where ${scored} and ${theses.marketYesPriceAtPublish} is not null)::text`,
    comparableBrier: sql<string | null>`avg(power(${theses.probabilityYes} - case when ${markets.resolutionSide} = 'yes' then 1 else 0 end, 2)) filter (where ${scored} and ${theses.marketYesPriceAtPublish} is not null)::text`,
    marketScored: sql<number>`count(*) filter (where ${scored} and ${theses.marketYesPriceAtPublish} is not null)::int`.mapWith(Number),
    profitUsd: sql<string>`coalesce(sum(${positions.profit}), 0)::numeric(16,4)::text`,
  }).from(authors).leftJoin(theses, and(eq(theses.authorId, authors.id), inArray(theses.status, ['published', 'resolved'])))
    .leftJoin(markets, eq(markets.id, theses.marketId)).leftJoin(positions, eq(positions.thesisId, theses.id))
    .where(ids ? inArray(authors.id, ids) : eq(authors.isTest, false)).groupBy(authors.id);
}
export type AuthorRecord = Awaited<ReturnType<typeof authorRecords>>[number];
export async function leaderboard(db: Db) {
  const rows = (await authorRecords(db)).filter(r => r.published > 0);
  return { asOf: new Date().toISOString(), byAccuracy: rows.filter(r => r.resolved > 0).sort((a,b) => Number(a.brier) - Number(b.brier) || b.resolved - a.resolved || a.id.localeCompare(b.id)).slice(0,50),
    byProfit: rows.filter(r => r.resolved + r.voided > 0).sort((a,b) => {
      const delta=units(b.profitUsd)-units(a.profitUsd);return delta>0n?1:delta<0n?-1:b.resolved-a.resolved||a.id.localeCompare(b.id);
    }).slice(0,50) };
}
export async function authorProfile(db: Db, id: string, cursor?: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [record] = await authorRecords(db, [id]);
  if (!record || (!record.published && record.kind !== 'agent')) return null;
  const { listThesisFeed } = await import('./feed');
  return { record, feed: await listThesisFeed(db, { kind: record.kind, authorId: id, cursor }) };
}
export async function escrowActivity(db: Db) {
  return { asOf: new Date().toISOString(), items: await db.select({ thesisId: theses.id, authorId: authors.id, author: authors.displayName,
    isTest: authors.isTest, market: markets.title, status: tips.status, tx: tips.settleTx,
    amountUsdc: sql<string>`sum(${tips.amountUsdc})::numeric(12,6)::text`,
    at: sql<string>`coalesce(max(${tips.settledAt}), max(${markets.resolvedAt}), max(${tips.createdAt}))::text`,
  }).from(tips)
    .innerJoin(theses, eq(theses.id, tips.thesisId)).innerJoin(authors, eq(authors.id, theses.authorId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .where(and(inArray(tips.status, ['paid', 'refunded']), inArray(theses.status, ['published','resolved'])))
    .groupBy(theses.id, authors.id, markets.id, tips.status, tips.settleTx)
    .orderBy(sql`coalesce(max(${tips.settledAt}), max(${markets.resolvedAt}), max(${tips.createdAt})) desc`, desc(theses.id)).limit(5) };
}
