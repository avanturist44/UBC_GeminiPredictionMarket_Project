import { and, audits, authors, eq, inArray, sql, theses, type Db } from '@thesis/db';
/** Old positions stay visible without falsely claiming a contemporaneous audit. */
export async function flagLegacyTheses(db: Db) {
  const rows = await db.select({ id: theses.id }).from(theses).innerJoin(authors, eq(authors.id, theses.authorId))
    .where(and(eq(authors.kind, 'agent'), inArray(theses.status, ['published', 'resolved']),
      sql`not exists (select 1 from ${audits} where ${audits.thesisId} = ${theses.id})`)).limit(100);
  let count = 0;
  for (const row of rows) count += await db.transaction(async tx => {
    await tx.select().from(theses).where(eq(theses.id, row.id)).for('update');
    const existing = await tx.select({ id: audits.id }).from(audits).where(eq(audits.thesisId, row.id));
    if (existing.length) return 0;
    await tx.insert(audits).values({ thesisId: row.id, verdict: 'flagged', model: 'legacy-review-v1', claims: [{
      text: 'No contemporaneous audit was recorded for this position.', status: 'unverifiable', source_url: null,
      note: 'This position predates audit integration. Historical inputs have not been independently checked; it is not marked as verified.',
    }] });
    return 1;
  });
  return count;
}
