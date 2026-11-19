import { z } from 'zod';
import { and, authors, copyRequests, desc, eq, gte, inArray, markets, sql, theses, tips, trades, users, walletAccounts, type Db } from '@thesis/db';
import { PublicationError } from './publication';
import { decimal, units } from './money';
type User = typeof users.$inferSelect;
export function effectiveLimits(user: User, now = Date.now()) {
  const due = user.limitsEffectiveAt !== null && user.limitsEffectiveAt.getTime() <= now;
  return { maxPerTradeUsd: due ? user.pendingMaxPerTradeUsd ?? user.maxPerTradeUsd : user.maxPerTradeUsd,
    dailyCopyCapUsd: due ? user.pendingDailyCopyCapUsd ?? user.dailyCopyCapUsd : user.dailyCopyCapUsd };
}
const amount = (max: number) => z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).refine(v => units(v) >= 10_000n && units(v) <= BigInt(max) * 10_000n);
export const LimitsInput = z.strictObject({ maxPerTradeUsd: amount(10), dailyCapUsd: amount(25) });
export async function changeLimits(db: Db, id: string, raw: unknown, now = Date.now()) {
  const input = LimitsInput.parse(raw);
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, id)).for('update');
    if (!user || user.tradingMode !== 'paper') throw new PublicationError('session_required', 401);
    const current = effectiveLimits(user, now);
    const raisedTrade = units(input.maxPerTradeUsd) > units(current.maxPerTradeUsd);
    const raisedDaily = units(input.dailyCapUsd) > units(current.dailyCopyCapUsd);
    const effectiveAt = raisedTrade || raisedDaily ? new Date(Date.parse(new Date(now).toISOString().slice(0, 10)) + 86_400_000) : null;
    await tx.update(users).set({ maxPerTradeUsd: raisedTrade ? current.maxPerTradeUsd : decimal(units(input.maxPerTradeUsd)),
      dailyCopyCapUsd: raisedDaily ? current.dailyCopyCapUsd : decimal(units(input.dailyCapUsd)),
      pendingMaxPerTradeUsd: raisedTrade ? decimal(units(input.maxPerTradeUsd)) : null,
      pendingDailyCopyCapUsd: raisedDaily ? decimal(units(input.dailyCapUsd)) : null, limitsEffectiveAt: effectiveAt }).where(eq(users.id, id));
    return { effectiveAt: effectiveAt?.toISOString() ?? null };
  });
}
export async function getAccount(db: Db, id: string, now = Date.now()) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new PublicationError('session_required', 401);
  const today = new Date(new Date(now).toISOString().slice(0, 10));
  const [positions, deposits, submitted, spent, wallet] = await Promise.all([
    db.select({ trade: trades, title: markets.title, thesisId: theses.id, copyId: copyRequests.id }).from(trades)
      .innerJoin(markets, eq(markets.id, trades.marketId)).leftJoin(theses, eq(theses.id, trades.thesisId))
      .leftJoin(copyRequests, eq(copyRequests.tradeId, trades.id)).where(eq(trades.userId, id)).orderBy(desc(trades.createdAt), desc(trades.id)).limit(50),
    db.select({ tip: tips, headline: theses.headline }).from(tips).innerJoin(theses, eq(theses.id, tips.thesisId))
      .where(eq(tips.userId, id)).orderBy(desc(tips.createdAt), desc(tips.id)).limit(50),
    db.select({ id: theses.id, headline: theses.headline, status: theses.status, outcome: theses.outcome }).from(theses)
      .innerJoin(authors, eq(authors.id, theses.authorId)).where(eq(authors.userId, id)).orderBy(desc(theses.createdAt), desc(theses.id)).limit(50),
    db.select({ total: sql<string>`coalesce(sum(${trades.costUsd}), 0)::text` }).from(trades).where(and(eq(trades.userId, id), eq(trades.mode, 'paper'),
      inArray(trades.status, ['filled', 'partial', 'settled']), gte(trades.createdAt, today))),
    db.select({ address: walletAccounts.address, status: walletAccounts.status }).from(walletAccounts).where(eq(walletAccounts.userId, id)),
  ]);
  const limits = effectiveLimits(user, now), total = units(spent[0]?.total ?? '0');
  const pending = user.limitsEffectiveAt && user.limitsEffectiveAt.getTime() > now;
  return { displayName: user.displayName, paperBalanceUsd: user.paperBalanceUsd, mode: 'paper' as const,
    maxPerTradeUsd: limits.maxPerTradeUsd, dailyCapUsd: limits.dailyCopyCapUsd, spentTodayUsd: decimal(total),
    remainingTodayUsd: decimal(units(limits.dailyCopyCapUsd) > total ? units(limits.dailyCopyCapUsd) - total : 0n),
    pendingLimits: pending ? { maxPerTradeUsd: user.pendingMaxPerTradeUsd, dailyCapUsd: user.pendingDailyCopyCapUsd,
      effectiveAt: user.limitsEffectiveAt!.toISOString() } : null,
    wallet: wallet[0] ?? null, positions: positions.map(({ trade, title, thesisId, copyId }) => ({ id: trade.id, title, thesisId, copyId,
      side: trade.side, quantity: trade.quantity, costUsd: trade.costUsd, payoutUsd: trade.payoutUsd, status: trade.status, at: trade.createdAt.toISOString() })),
    tips: deposits.map(({ tip, headline }) => ({ id: tip.id, thesisId: tip.thesisId, headline, amountUsdc: tip.amountUsdc, status: tip.status,
      depositTx: tip.depositTx, settleTx: tip.settleTx })), theses: submitted };
}
export type AccountView = Awaited<ReturnType<typeof getAccount>>;
