import { and, asc, auditControl, audits, desc, eq, gte, lt, markets, sql, theses, thesisJobs, type Db } from '@thesis/db';
import { type AuditProvider } from './audit';
import { publishHuman, type QuoteLease } from './human-paper';
import { PublicationError } from './publication';

/** A global reservation prevents duplicate/bursty paid calls across worker processes. */
async function claim(db: Db, now: number, registrationRequired: boolean, hasProvider: boolean) {
  return db.transaction(async tx => {
    await tx.insert(auditControl).values({ id: 1 }).onConflictDoNothing();
    await tx.select().from(auditControl).where(eq(auditControl.id, 1)).for('update');
    const expired = await tx.select().from(thesisJobs).where(and(eq(thesisJobs.status, 'running'), lt(thesisJobs.startedAt, new Date(now - 120_000))));
    for (const job of expired) {
      const [thesis] = await tx.select().from(theses).where(eq(theses.id, job.thesisId));
      const committed = thesis?.status === 'published' || thesis?.status === 'resolved';
      await tx.update(thesisJobs).set({ status: committed ? 'completed' : 'failed', errorCode: committed ? null : 'audit_interrupted', finishedAt: new Date(now) }).where(eq(thesisJobs.thesisId, job.thesisId));
      await tx.update(theses).set({ status: 'draft' }).where(and(eq(theses.id, job.thesisId), eq(theses.status, 'auditing')));
    }
    if (registrationRequired) {
      const [ready] = await tx.select({ job: thesisJobs }).from(thesisJobs).innerJoin(theses, eq(theses.id, thesisJobs.thesisId))
        .where(and(eq(thesisJobs.status, 'registering'), sql`${theses.registerTx} is not null`))
        .orderBy(asc(thesisJobs.createdAt)).limit(1).for('update', { skipLocked: true });
      if (ready) {
        await tx.update(thesisJobs).set({ status: 'running', startedAt: new Date(now) }).where(eq(thesisJobs.thesisId, ready.job.thesisId));
        return { ...ready.job, preAudited: true };
      }
    }
    if (!hasProvider) return null;
    const recent = await tx.select({ id: thesisJobs.thesisId }).from(thesisJobs).where(gte(thesisJobs.startedAt, new Date(now - 3600_000)));
    if (recent.length >= 20) return null;
    const [job] = await tx.select().from(thesisJobs).where(eq(thesisJobs.status, 'queued'))
      .orderBy(asc(thesisJobs.createdAt), asc(thesisJobs.thesisId)).limit(1).for('update', { skipLocked: true });
    if (!job) return null;
    await tx.update(thesisJobs).set({ status: 'running', startedAt: new Date(now) }).where(eq(thesisJobs.thesisId, job.thesisId));
    return { ...job, preAudited: false };
  });
}

export async function processThesisJob(db: Db, options: {
  provider?: AuditProvider; quote: (market: { eventTicker: string; instrumentSymbol: string }) => Promise<QuoteLease>;
  enabled: () => boolean; now?: () => number; signal?: AbortSignal;
  requireRegistration?: string;
}) {
  if (!options.enabled()) return { processed: false };
  const now = options.now ?? Date.now;
  const job = await claim(db, now(), !!options.requireRegistration, !!options.provider);
  if (!job) return { processed: false };
  let lease: QuoteLease | undefined;
  let auditAtMs: number | undefined;
  try {
    const [row] = await db.select({ thesis: theses, market: markets }).from(theses)
      .innerJoin(markets, eq(markets.id, theses.marketId)).where(eq(theses.id, job.thesisId));
    if (!row || row.thesis.status !== 'auditing') throw new PublicationError('audit_interrupted');
    if (row.market.status !== 'active' || row.market.marketState !== 'open' || !row.market.expiryAt ||
      row.market.expiryAt.getTime() - now() < 120_000) throw new PublicationError('market_unavailable');
    const [previous] = job.preAudited ? await db.select().from(audits).where(eq(audits.thesisId, job.thesisId)).orderBy(desc(audits.createdAt), desc(audits.id)).limit(1) : [];
    if (job.preAudited && (!previous || previous.verdict === 'blocked' || now() - previous.createdAt.getTime() > 15 * 60_000)) throw new PublicationError('audit_expired');
    auditAtMs = previous?.createdAt.getTime();
    const result = previous ?? await options.provider!.audit({ headline: row.thesis.headline, body: row.thesis.body,
      evidence: row.thesis.evidence, market: { title: row.market.title, symbol: row.market.instrumentSymbol,
        expiryAt: row.market.expiryAt.toISOString(), yesBid: row.market.yesBid, yesAsk: row.market.yesAsk,
        asOf: row.market.updatedAt.toISOString() } }, options.signal);
    if (!job.preAudited) await db.transaction(async tx => {
      const [current] = await tx.select().from(thesisJobs).where(eq(thesisJobs.thesisId, job.thesisId)).for('update');
      if (current?.status !== 'running' || now() - current.startedAt!.getTime() >= 120_000) throw new PublicationError('audit_interrupted');
      await tx.insert(audits).values({ thesisId: job.thesisId, ...result, createdAt: new Date(now()) });
      if (result.verdict === 'blocked') {
        await tx.update(theses).set({ status: 'blocked' }).where(eq(theses.id, job.thesisId));
        await tx.update(thesisJobs).set({ status: 'completed', finishedAt: new Date(now()) }).where(eq(thesisJobs.thesisId, job.thesisId));
      }
    });
    if (result.verdict === 'blocked') return { processed: true, thesisId: job.thesisId, verdict: 'blocked' };
    if (options.requireRegistration && !job.preAudited) {
      await db.update(thesisJobs).set({ status: 'registering' }).where(eq(thesisJobs.thesisId, job.thesisId));
      return { processed: true, thesisId: job.thesisId, stage: 'registering' };
    }
    lease = await options.quote(row.market);
    await publishHuman(db, job.thesisId, lease.read, { enabled: options.enabled, now, requireRegistration: options.requireRegistration });
    // Publication is authoritative. If a process dies here, recovery recognizes the committed thesis.
    await db.update(thesisJobs).set({ status: 'completed', finishedAt: new Date(now()) }).where(eq(thesisJobs.thesisId, job.thesisId));
    return { processed: true, thesisId: job.thesisId, verdict: result.verdict };
  } catch (error) {
    const code = error instanceof PublicationError ? error.code : 'audit_unavailable';
    if (job.preAudited && ['quote_unavailable', 'quote_changed', 'no_fill'].includes(code) && auditAtMs !== undefined && now() - auditAtMs < 15 * 60_000) {
      const [market] = await db.select({ market: markets }).from(theses).innerJoin(markets, eq(markets.id, theses.marketId)).where(eq(theses.id, job.thesisId));
      if (market?.market.status === 'active' && market.market.marketState === 'open' && (market.market.expiryAt?.getTime() ?? 0) - now() > 120_000) {
        await db.update(thesisJobs).set({ status: 'registering', errorCode: 'waiting_for_book' }).where(eq(thesisJobs.thesisId, job.thesisId));
        return { processed: true, thesisId: job.thesisId, stage: 'waiting_for_book' };
      }
    }
    await db.transaction(async tx => {
      // Match the reservation/result path's job -> thesis lock order.
      await tx.select().from(thesisJobs).where(eq(thesisJobs.thesisId, job.thesisId)).for('update');
      const [thesis] = await tx.select().from(theses).where(eq(theses.id, job.thesisId)).for('update');
      const published = thesis?.status === 'published' || thesis?.status === 'resolved';
      await tx.update(thesisJobs).set({ status: published ? 'completed' : 'failed',
        errorCode: published ? null : code, finishedAt: new Date(now()) }).where(eq(thesisJobs.thesisId, job.thesisId));
      if (thesis?.status === 'auditing') await tx.update(theses).set({ status: 'draft' }).where(eq(theses.id, job.thesisId));
    });
    return { processed: true, thesisId: job.thesisId, errorCode: code };
  } finally { lease?.close(); }
}
