import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, authors, copyRequests, eq, gte, inArray, markets, sessionWindows, theses, thesisRegistrations, tips, trades, users, walletAccounts, type Db } from '@thesis/db';
import { hashContent, PublicationError } from './publication';
import { decimal, paperFill, units } from './money';
import { usdcDecimal, usdcUnits } from './chain/abi';
import { effectiveLimits } from './account';
import type { ExecutableQuote } from './human-paper';
export const CopyAmount = z.string().regex(/^(?:[1-9](?:\.\d{1,2})?|10(?:\.0{1,2})?)$/);
export const CopyTip = z.string().regex(/^(?:0(?:\.\d{1,6})?)$/).refine(value => usdcUnits(value) <= 500_000n);
export const CopyInput = z.strictObject({ idempotencyKey: z.string().uuid(), amountUsd: CopyAmount, tipUsdc: CopyTip,
  quoteToken: z.string().min(20).max(2000), acceptPriceMoved: z.boolean().default(false) });
export type CopyFunds = { ready: boolean; balance: bigint; allowance: bigint; observedAtMs: number };
const TokenPayload = z.strictObject({ userId: z.string().uuid(), thesisId: z.string().uuid(), amountUsd: z.string(), tipUsdc: z.string(), limitPrice: z.string(), expiresAt: z.number() });
function signature(payload: string, secret: string) {
  if (secret.length < 32) throw new PublicationError('session_not_configured', 503);
  return createHmac('sha256', secret).update(`copy-quote:${payload}`).digest('base64url');
}
export function signCopyQuote(payload: z.infer<typeof TokenPayload>, secret: string) {
  const encoded = Buffer.from(JSON.stringify(TokenPayload.parse(payload))).toString('base64url');
  return `${encoded}.${signature(encoded, secret)}`;
}
function readToken(value: string, secret: string, now: number) {
  try {
    const [payload, signed, extra] = value.split('.'); if (!payload || !signed || extra) throw new Error();
    const expected = Buffer.from(signature(payload, secret)), actual = Buffer.from(signed);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const decoded = TokenPayload.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (decoded.expiresAt <= now || decoded.expiresAt > now + 31_000) throw new Error();
    return decoded;
  } catch { throw new PublicationError('quote_expired'); }
}
export async function consumeUserWrite(db: Db, userId: string, now = Date.now()) {
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw new PublicationError('session_required', 401);
    const [window] = await tx.select().from(sessionWindows).where(eq(sessionWindows.userId, userId));
    const current = window && now - window.windowAt.getTime() < 60_000;
    if (current && window.writes >= 10) throw new PublicationError('rate_limit', 429);
    await tx.insert(sessionWindows).values({ userId, windowAt: new Date(now), writes: 1 }).onConflictDoUpdate({ target: sessionWindows.userId,
      set: { windowAt: current ? window.windowAt : new Date(now), writes: current ? window.writes + 1 : 1 } });
  });
}
async function copyRows(db: Db, thesisId: string, userId: string, escrowAddress: string) {
  const [row] = await db.select({ thesis: theses, author: authors, market: markets, registration: thesisRegistrations }).from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .leftJoin(thesisRegistrations, eq(thesisRegistrations.thesisId, theses.id)).where(eq(theses.id, thesisId));
  if (!row || row.thesis.status !== 'published' || !row.registration?.confirmedAt || !row.thesis.registerTx ||
    row.registration.escrowAddress.toLowerCase() !== escrowAddress.toLowerCase()) throw new PublicationError('thesis_not_copyable');
  if (row.author.userId === userId) throw new PublicationError('own_thesis');
  return row;
}
function checkedFill(quote: ExecutableQuote | null, symbol: string, side: 'yes' | 'no', amount: string, now: number) {
  if (!quote || quote.symbol !== symbol || quote.status !== 'active' || quote.marketState !== 'open' ||
    !Number.isFinite(quote.expiryMs) || quote.expiryMs - now < 120_000 ||
    now - quote.observedAtMs < 0 || now - quote.observedAtMs > 10_000 || now - quote.marketObservedAtMs < 0 || now - quote.marketObservedAtMs > 10_000 ||
    quote.bid <= 0 || quote.ask >= 1 || quote.ask < quote.bid || quote.ask - quote.bid > 0.060000001) throw new PublicationError('quote_unavailable');
  const fill = paperFill(side === 'yes' ? quote.ask : 1 - quote.bid, side === 'yes' ? quote.askSize : quote.bidSize,
    quote.quantityIncrement, quote.quantityMinimum, units(amount));
  if (!fill) throw new PublicationError('no_fill'); return fill;
}
export async function quoteCopy(db: Db, thesisId: string, userId: string, amountUsd: string, tipUsdc: string,
  quote: ExecutableQuote | null, options: { escrowAddress: string; secret: string; now?: number }) {
  CopyAmount.parse(amountUsd); CopyTip.parse(tipUsdc);
  const now = options.now ?? Date.now();
  const row = await copyRows(db, thesisId, userId, options.escrowAddress);
  const fill = checkedFill(quote, row.market.instrumentSymbol, row.thesis.side, amountUsd, now);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.tradingMode !== 'paper') throw new PublicationError('session_required', 401);
  const limits = effectiveLimits(user, now);
  if (units(amountUsd) > units(limits.maxPerTradeUsd)) throw new PublicationError('per_trade_limit');
  const spent = await db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.mode, 'paper'),
    inArray(trades.status, ['filled', 'partial', 'settled']), gte(trades.createdAt, new Date(new Date(now).toISOString().slice(0, 10)))));
  const remaining = units(limits.dailyCopyCapUsd) - spent.reduce((sum, trade) => sum + units(trade.costUsd), 0n);
  if (units(amountUsd) > remaining) throw new PublicationError('daily_limit');
  if (units(fill.costUsd) > units(user.paperBalanceUsd)) throw new PublicationError('insufficient_balance');
  return { ...fill, side: row.thesis.side, authorEntryPrice: row.thesis.entryPrice,
    maxPaperLossUsd: fill.costUsd, winningPayoutUsd: fill.quantity, tipUsdc: usdcDecimal(usdcUnits(tipUsdc)), remainingDailyUsd: decimal(remaining),
    priceMoved: row.thesis.entryPrice !== null && units(fill.price) > units(row.thesis.entryPrice) + 500n,
    expiresAt: new Date(now + 30_000).toISOString(),
    quoteToken: signCopyQuote({ userId, thesisId, amountUsd, tipUsdc, limitPrice: fill.price, expiresAt: now + 30_000 }, options.secret) };
}

export async function copyTrade(db: Db, thesisId: string, userId: string, raw: unknown, options: {
  escrowAddress: string; secret: string; enabled: () => boolean; readQuote: () => ExecutableQuote | null;
  readFunds: () => CopyFunds; now?: () => number;
}) {
  const input = CopyInput.parse(raw), now = options.now ?? Date.now;
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user || user.tradingMode !== 'paper') throw new PublicationError('session_required', 401);
    const [existing] = await tx.select().from(copyRequests).where(eq(copyRequests.id, input.idempotencyKey));
    if (existing) {
      if (existing.userId !== userId || existing.thesisId !== thesisId || units(existing.amountUsd) !== units(input.amountUsd) || usdcUnits(existing.tipUsdc) !== usdcUnits(input.tipUsdc)) throw new PublicationError('idempotency_conflict');
      return { id: existing.id, tradeId: existing.tradeId, tipId: existing.tipId };
    }
    const at = now();
    const limits = effectiveLimits(user, at);
    const confirmed = readToken(input.quoteToken, options.secret, at);
    if (confirmed.userId !== userId || confirmed.thesisId !== thesisId || confirmed.amountUsd !== input.amountUsd || confirmed.tipUsdc !== input.tipUsdc) throw new PublicationError('quote_expired');
    if (!options.enabled()) throw new PublicationError('trading_disabled', 503);
    const row = await copyRows(tx, thesisId, userId, options.escrowAddress);
    if (row.market.status !== 'active' || row.market.marketState !== 'open') throw new PublicationError('market_unavailable');
    const quote = options.readQuote();
    const fill = checkedFill(quote, row.market.instrumentSymbol, row.thesis.side, input.amountUsd, at);
    if (units(fill.price) > units(confirmed.limitPrice)) throw new PublicationError('price_moved');
    if (row.thesis.entryPrice === null) throw new PublicationError('thesis_not_copyable');
    if (units(fill.price) > units(row.thesis.entryPrice) + 500n && !input.acceptPriceMoved) throw new PublicationError('price_moved');
    const budget = units(input.amountUsd), tip = usdcUnits(input.tipUsdc);
    if (budget > units(limits.maxPerTradeUsd) || budget > 100_000n) throw new PublicationError('per_trade_limit');
    const spent = await tx.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.mode, 'paper'),
      inArray(trades.status, ['filled', 'partial', 'settled']), gte(trades.createdAt, new Date(new Date(at).toISOString().slice(0, 10)))));
    if (spent.reduce((sum, trade) => sum + units(trade.costUsd), 0n) + budget > units(limits.dailyCopyCapUsd)) throw new PublicationError('daily_limit');
    if (units(user.paperBalanceUsd) < units(fill.costUsd)) throw new PublicationError('insufficient_balance');
    if (tip > 0n) {
      const [wallet] = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId));
      const funds = options.readFunds();
      if (wallet?.status !== 'ready' || !wallet.circleWalletId || !wallet.address || !funds.ready) throw new PublicationError('wallet_not_ready');
      if (now() - funds.observedAtMs < 0 || now() - funds.observedAtMs > 10_000) throw new PublicationError('quote_expired');
      const prior = await tx.select().from(tips).where(and(eq(tips.userId, userId), inArray(tips.status, ['pending', 'escrowed', 'paid', 'refunded'])));
      if (prior.filter(t => t.thesisId === thesisId).reduce((sum, t) => sum + usdcUnits(t.amountUsdc), 0n) + tip > 5_000_000n) throw new PublicationError('tip_limit');
      const reserved = prior.filter(t => t.status === 'pending').reduce((sum, t) => sum + usdcUnits(t.amountUsdc), 0n);
      if (funds.balance - reserved < tip || funds.allowance - reserved < tip) throw new PublicationError('insufficient_usdc');
    }
    const [trade] = await tx.insert(trades).values({ ...fill, userId, authorId: null, thesisId, marketId: row.market.id,
      isAuthorPosition: false, locked: true, side: row.thesis.side, mode: 'paper', status: 'filled',
      idempotencyKey: `paper:copy:${input.idempotencyKey}`, createdAt: new Date(at) }).returning();
    await tx.update(users).set({ paperBalanceUsd: decimal(units(user.paperBalanceUsd) - units(fill.costUsd)) }).where(eq(users.id, userId));
    if (tip > 0n) await tx.insert(tips).values({ id: input.idempotencyKey, thesisId, userId, tradeId: trade!.id, amountUsdc: usdcDecimal(tip), createdAt: new Date(at) });
    await tx.insert(copyRequests).values({ id: input.idempotencyKey, userId, thesisId, amountUsd: input.amountUsd,
      tipUsdc: usdcDecimal(tip), tradeId: trade!.id, tipId: tip > 0n ? input.idempotencyKey : null, createdAt: new Date(at) });
    const latest = options.readQuote();
    checkedFill(latest, row.market.instrumentSymbol, row.thesis.side, input.amountUsd, now());
    if (!options.enabled() || latest!.bid !== quote!.bid || latest!.ask !== quote!.ask ||
      (row.thesis.side === 'yes' ? latest!.askSize : latest!.bidSize) < Number(fill.quantity) ||
      new Date(now()).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10)) throw new PublicationError('quote_changed');
    return { id: input.idempotencyKey, tradeId: trade!.id, tipId: tip > 0n ? input.idempotencyKey : null };
  });
}

export async function getCopy(db: Db, id: string, userId: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await db.select({ copy: copyRequests, trade: trades, tip: tips }).from(copyRequests)
    .innerJoin(trades, eq(trades.id, copyRequests.tradeId)).leftJoin(tips, eq(tips.id, copyRequests.tipId))
    .where(and(eq(copyRequests.id, id), eq(copyRequests.userId, userId)));
  return row ? { id: row.copy.id, thesisId: row.copy.thesisId,
    trade: { side: row.trade.side, quantity: row.trade.quantity, price: row.trade.price, costUsd: row.trade.costUsd, status: row.trade.status, payoutUsd: row.trade.payoutUsd },
    tip: row.tip ? { amountUsdc: row.tip.amountUsdc, status: row.tip.status, depositTx: row.tip.depositTx, settleTx: row.tip.settleTx } : null } : null;
}
