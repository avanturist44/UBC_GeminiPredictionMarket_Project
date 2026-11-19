import { randomUUID } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { z } from 'zod';
import { and, audits, authors, eq, gte, inArray, markets, sessionWindows, theses, thesisJobs, users, type Db } from '@thesis/db';
import { publicSource, screenThesis } from './audit';

export class PublicationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const EvidenceSchema = z.strictObject({ claim: z.string().trim().min(1).max(500),
  url: z.string().max(2048).refine(value => publicSource(value) !== null, 'Use a public HTTPS source.') });
export const ThesisSubmissionSchema = z.strictObject({
  idempotencyKey: z.string().uuid(), symbol: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  headline: z.string().trim().min(5).max(90), body: z.string().trim().min(20).max(1200),
  side: z.enum(['yes', 'no']), probabilityYes: z.number().min(0).max(1).multipleOf(0.01),
  stakeUsd: z.string().regex(/^(?:[1-9](?:\.\d{1,2})?|10(?:\.0{1,2})?)$/),
  evidence: z.array(EvidenceSchema).min(1).max(6),
});
export type ThesisSubmission = z.infer<typeof ThesisSubmissionSchema>;
export const hashContent = (text: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
export async function createGuest(db: Db, displayName: string) {
  const name = z.string().trim().min(2).max(40).parse(displayName);
  return db.transaction(async tx => {
    const [user] = await tx.insert(users).values({ displayName: name }).returning();
    await tx.insert(authors).values({ kind: 'human', userId: user!.id, displayName: name });
    return user!;
  });
}

export async function submitThesis(db: Db, userId: string, value: unknown, now = Date.now()) {
  const input = ThesisSubmissionSchema.parse(value);
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user || user.tradingMode !== 'paper') throw new PublicationError('session_required', 401);
    const [author] = await tx.select().from(authors).where(eq(authors.userId, userId));
    if (!author) throw new PublicationError('session_required', 401);
    const contentHash = hashContent(JSON.stringify(input));
    const [existing] = await tx.select().from(theses).where(eq(theses.id, input.idempotencyKey));
    if (existing) {
      if (existing.authorId !== author.id || existing.contentHash !== contentHash) throw new PublicationError('idempotency_conflict');
      return { id: existing.id, status: existing.status };
    }
    const [window] = await tx.select().from(sessionWindows).where(eq(sessionWindows.userId, userId));
    const sameWindow = window && now - window.windowAt.getTime() < 60_000;
    if (sameWindow && window.writes >= 10) throw new PublicationError('rate_limit', 429);
    const attempts = await tx.select({ id: theses.id }).from(theses).where(and(eq(theses.authorId, author.id),
      gte(theses.createdAt, new Date(now - 3600_000))));
    if (attempts.length >= 10) throw new PublicationError('audit_budget', 429);
    const [market] = await tx.select().from(markets).where(eq(markets.instrumentSymbol, input.symbol));
    if (!market?.tracked || market.status !== 'active' || market.marketState !== 'open' ||
      !market.expiryAt || market.expiryAt.getTime() - now < 180_000) throw new PublicationError('market_unavailable');
    const duplicate = await tx.select({ id: theses.id }).from(theses).where(and(eq(theses.authorId, author.id),
      eq(theses.marketId, market.id), inArray(theses.status, ['auditing', 'published', 'resolved'])));
    if (duplicate.length) throw new PublicationError('position_exists');
    await tx.insert(sessionWindows).values({ userId, windowAt: new Date(now), writes: 1 })
      .onConflictDoUpdate({ target: sessionWindows.userId,
        set: { windowAt: sameWindow ? window.windowAt : new Date(now), writes: sameWindow ? window.writes + 1 : 1 } });
    const screened = screenThesis(input.headline, input.body);
    await tx.insert(theses).values({ id: input.idempotencyKey, onchainId: hashContent(input.idempotencyKey),
      authorId: author.id, marketId: market.id, headline: input.headline, body: input.body,
      side: input.side, probabilityYes: input.probabilityYes.toFixed(4), evidence: input.evidence,
      status: screened ? 'blocked' : 'auditing', contentHash, createdAt: new Date(now) });
    await tx.insert(thesisJobs).values({ thesisId: input.idempotencyKey, stakeUsd: input.stakeUsd,
      status: screened ? 'completed' : 'queued', finishedAt: screened ? new Date(now) : null,
      createdAt: new Date(now) });
    if (screened) await tx.insert(audits).values({ thesisId: input.idempotencyKey, ...screened, createdAt: new Date(now) });
    return { id: input.idempotencyKey, status: screened ? 'blocked' : 'auditing' };
  });
}
