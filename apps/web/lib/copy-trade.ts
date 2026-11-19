import {
  MIN_MINUTES_TO_COPY,
  checkDailyCopyCap,
  checkNotOwnThesis,
  checkPerTradeCap,
  checkSlippage,
  checkTipCap,
  fromUnits,
  planOrder,
  sideAsk,
  toUnits,
} from '@thesis/core';
import { createHash } from 'node:crypto';
import { and, eq, getThesisView, inArray, sql, tips, trades, users, type Db, type TradeRow, type UserRow } from '@thesis/db';
import { z } from 'zod';
import type { ApiError } from './market-view';

/**
 * `POST /api/theses/[id]/copy`: places the same side as a published thesis for the user.
 *
 * The fill is simulated ("paper"): test money at the price Gemini is quoting. Every limit is
 * checked here on the server, immediately before the trade, whatever the browser showed.
 * The position is locked until the market resolves; there is no sell path.
 *
 * The trade and the tip are separate on purpose: a tip that fails never undoes a filled
 * trade. A tip is test USDC held by the escrow contract until the market resolves. This
 * route only records it as `pending`; the worker sends it from the user's wallet and marks
 * it `escrowed` or `failed`. No wallet key or Circle secret is ever used by the web app.
 */

export const CopyRequestSchema = z.object({
  /** Dollars of test money to spend. Whole cents. */
  amountUsd: z
    .number()
    .positive()
    .max(1000)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, 'Use whole cents.'),
  tipUsdc: z.number().min(0).max(5).default(0),
  /** Chosen by the client once per attempt. Repeating a request with it returns the first result. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

export interface CopyResponse {
  trade: { id: string; side: 'yes' | 'no'; quantity: string; price: string; costUsd: string; status: string };
  /** The most this position can lose, and what it pays if the thesis is right. */
  maxLossUsd: string;
  payoutIfRightUsd: string;
  tip: { id: string | null; status: TipState; amountUsdc: string };
  /** True when this is the stored result of an earlier request with the same key. */
  repeated: boolean;
}

export type TipState = 'none' | 'pending' | 'escrowed' | 'paid' | 'refunded' | 'failed';

/** A tip's row id, fixed by the request key, so a repeated request finds the same tip. */
function tipIdFor(key: string): string {
  const h = createHash('sha256').update(`${key}:tip`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Copied =
  | { ok: true; data: CopyResponse }
  | { ok: false; status: number; error: ApiError & { price?: string } };

const refuse = (status: number, code: string, message: string, price?: string): Copied => ({
  ok: false,
  status,
  error: price ? { code, message, price } : { code, message },
});

const MAX_QUOTE_AGE_MS = 120_000;
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function toResponse(trade: TradeRow, repeated: boolean, tip: CopyResponse['tip']): CopyResponse {
  return {
    trade: {
      id: trade.id,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      costUsd: trade.costUsd,
      status: trade.status,
    },
    maxLossUsd: trade.costUsd,
    payoutIfRightUsd: trade.quantity,
    tip,
    repeated,
  };
}

/** What a user's copy trades have cost since `since`. Rejected ones cost nothing. */
export async function copiedSince(db: Db, userId: string, since: Date): Promise<string> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${trades.costUsd}), 0)::text` })
    .from(trades)
    .where(
      and(
        eq(trades.userId, userId),
        eq(trades.isAuthorPosition, false),
        inArray(trades.status, ['filled', 'partial', 'settled']),
        sql`${trades.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return fromUnits(toUnits(Number(row?.total ?? 0).toFixed(4)));
}

export async function copyTrade(
  db: Db,
  user: UserRow,
  thesisId: string,
  body: unknown,
  options: {
    now: Date;
    tradingEnabled: boolean;
    /** The escrow contract is configured. A thesis must also be registered in it to take tips. */
    tipsEnabled: boolean;
  },
): Promise<Copied> {
  if (!options.tradingEnabled) return refuse(503, 'trading_disabled', 'Trading is switched off right now.');
  const parsed = CopyRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(400, 'invalid', `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'not valid'}`);
  }
  const amountUsd = parsed.data.amountUsd.toFixed(2);
  const tipUsdc = parsed.data.tipUsdc.toFixed(2);
  const key = `copy:${user.id}:${parsed.data.idempotencyKey}`;

  const tipId = tipIdFor(key);
  const tipOf = async (): Promise<CopyResponse['tip']> => {
    const [tip] = await db.select().from(tips).where(eq(tips.id, tipId)).limit(1);
    return tip ? { id: tip.id, status: tip.status, amountUsdc: tip.amountUsdc } : { id: null, status: 'none', amountUsdc: '0' };
  };
  const existing = async (): Promise<Copied | null> => {
    const [trade] = await db.select().from(trades).where(eq(trades.idempotencyKey, key)).limit(1);
    if (!trade) return null;
    if (trade.thesisId !== thesisId) return refuse(409, 'key_reused', 'That request key was already used for another thesis.');
    return { ok: true, data: toResponse(trade, true, await tipOf()) };
  };
  const repeated = await existing();
  if (repeated) return repeated;

  if (!/^[0-9a-f-]{36}$/i.test(thesisId)) return refuse(404, 'not_found', 'There is no thesis at this address.');
  const view = await getThesisView(db, thesisId);
  if (!view || view.thesis.status === 'draft' || view.thesis.status === 'auditing' || view.thesis.status === 'blocked') {
    return refuse(404, 'not_found', 'There is no published thesis at this address.');
  }
  const { thesis, market, author } = view;
  const minutesLeft = market.expiryAt ? (market.expiryAt.getTime() - options.now.getTime()) / 60_000 : null;
  if (thesis.status !== 'published' || market.marketState !== 'open' || market.resolutionSide !== null) {
    return refuse(409, 'market_closed', 'This market has closed, so the trade can no longer be copied.');
  }
  if (minutesLeft !== null && minutesLeft < MIN_MINUTES_TO_COPY) {
    return refuse(409, 'market_closing', `This market closes in under ${MIN_MINUTES_TO_COPY} minutes, too late to copy.`);
  }

  for (const check of [
    checkNotOwnThesis(user.id, author.userId),
    checkPerTradeCap(amountUsd, user.maxPerTradeUsd),
    checkTipCap(tipUsdc),
  ]) {
    if (!check.ok) return refuse(check.code === 'bad_amount' || check.code === 'bad_tip' ? 400 : 409, check.code, check.message);
  }
  const today = startOfUtcDay(options.now);
  const daily = checkDailyCopyCap(amountUsd, await copiedSince(db, user.id, today), user.dailyCopyCapUsd);
  if (!daily.ok) return refuse(409, daily.code, daily.message);
  const wantsTip = toUnits(tipUsdc) > 0n;
  if (wantsTip && !(options.tipsEnabled && thesis.registerTx !== null)) {
    return refuse(503, 'tips_unavailable', 'This thesis cannot take tips. Copy without a tip.');
  }

  if (options.now.getTime() - market.updatedAt.getTime() > MAX_QUOTE_AGE_MS) {
    return refuse(409, 'stale_price', 'Prices for this market are not updating right now. Try again in a minute.');
  }
  const ask = sideAsk(thesis.side, market);
  if (ask === null) return refuse(409, 'no_fill', `Nobody is selling ${thesis.side.toUpperCase()} right now, so nothing was bought.`);
  if (thesis.entryPrice === null) return refuse(409, 'no_fill', 'This thesis has no entry price to copy.');
  const slippage = checkSlippage(ask, thesis.entryPrice);
  if (!slippage.ok) return refuse(409, slippage.code, slippage.message, ask);

  const plan = planOrder({
    budgetUsd: amountUsd,
    price: ask,
    quantityIncrement: market.quantityIncrement,
    quantityMinimum: market.quantityMinimum,
  });
  if (!plan.ok) return refuse(400, plan.code, plan.message);

  let result: Copied;
  try {
    result = await db.transaction(async (tx): Promise<Copied> => {
      // The user's row is the lock: their copies, balance and daily total change one at a time.
      const [locked] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
      if (!locked) return refuse(401, 'no_session', 'Start a session first.');
      const again = checkDailyCopyCap(amountUsd, await copiedSince(tx, user.id, today), locked.dailyCopyCapUsd);
      if (!again.ok) return refuse(409, again.code, again.message);
      const balance = toUnits(locked.paperBalanceUsd);
      const cost = toUnits(plan.costUsd);
      if (cost > balance) {
        return refuse(409, 'insufficient_balance', `Your paper balance is $${Number(locked.paperBalanceUsd).toFixed(2)}.`);
      }
      const [trade] = await tx
        .insert(trades)
        .values({
          userId: user.id,
          marketId: market.id,
          thesisId: thesis.id,
          isAuthorPosition: false,
          side: thesis.side,
          quantity: plan.quantity,
          price: ask,
          costUsd: plan.costUsd,
          mode: 'paper',
          status: 'filled',
          locked: true,
          idempotencyKey: key,
        })
        .returning();
      if (!trade) throw new Error('copy trade insert returned no row');
      await tx.update(users).set({ paperBalanceUsd: fromUnits(balance - cost) }).where(eq(users.id, user.id));
      return { ok: true, data: toResponse(trade, false, { id: null, status: 'none', amountUsdc: '0' }) };
    });
  } catch (error) {
    // The same key arriving twice at once: the unique index lets one insert through.
    const first = await existing();
    if (first) return first;
    throw error;
  }
  if (!result.ok || !wantsTip) return result;

  // The trade is filled and stays filled whatever happens to the tip from here.
  try {
    await db.insert(tips).values({ id: tipId, thesisId: thesis.id, userId: user.id, amountUsdc: tipUsdc }).onConflictDoNothing();
    result.data.tip = await tipOf();
  } catch (error) {
    console.error('tip could not be recorded', error);
    result.data.tip = { id: null, status: 'failed', amountUsdc: tipUsdc };
  }
  return result;
}
