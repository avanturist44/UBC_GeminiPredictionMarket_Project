import { randomUUID } from 'node:crypto';
import {
  ThesisSubmissionSchema,
  checkSideAgainstPrice,
  fromUnits,
  planOrder,
  sideAsk,
  thesisContentHash,
  thesisOnchainId,
  toUnits,
} from '@thesis/core';
import {
  countAuditingTheses,
  countThesesSince,
  createAuditingThesis,
  ensureHumanAuthor,
  getMarketBySymbol,
  hasOpenThesis,
  type Db,
  type UserRow,
} from '@thesis/db';
import type { ApiError } from './market-view';
import type { SubmitResponse } from './thesis-view';

/**
 * `POST /api/theses`: checks a person's thesis and stores it for the auditor.
 *
 * Nothing is traded or charged here. The thesis is stored as `auditing` with the author's
 * intended position; the worker audits it, then fills the position and publishes, or
 * blocks it. Every rule below is checked on the server, whatever the browser sent.
 */

export type Submitted = { ok: true; data: SubmitResponse } | { ok: false; status: number; error: ApiError };

const refuse = (status: number, code: string, message: string): Submitted => ({ ok: false, status, error: { code, message } });

/** How far past the price shown the author's trade may still fill. Beyond it they are asked again. */
const SLIPPAGE = 500n; // 0.05, in ten-thousandths
/** A thesis needs time to be audited before its market closes. */
const MIN_MINUTES_TO_EXPIRY = 5;
/** A quote older than this is not a price: the recorder has stopped. */
const MAX_QUOTE_AGE_MS = 120_000;
/** Each submission costs an audit, so an author gets this many a UTC day. */
const MAX_THESES_PER_DAY = 20;

export async function submitThesis(
  db: Db,
  user: UserRow,
  body: unknown,
  options: { now: Date; tradingEnabled: boolean },
): Promise<Submitted> {
  if (!options.tradingEnabled) {
    return refuse(503, 'trading_disabled', 'Trading is switched off, so new theses cannot be published right now.');
  }
  const parsed = ThesisSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '';
    return refuse(400, 'invalid', `${field ? `${field}: ` : ''}${issue?.message ?? 'The thesis is not valid.'}`);
  }
  const input = parsed.data;

  const market = await getMarketBySymbol(db, input.symbol);
  if (!market) return refuse(404, 'not_found', 'No tracked market has this symbol.');
  const minutesLeft = market.expiryAt ? (market.expiryAt.getTime() - options.now.getTime()) / 60_000 : null;
  if (market.marketState !== 'open' || market.resolutionSide !== null || (minutesLeft !== null && minutesLeft <= 0)) {
    return refuse(409, 'market_closed', 'This market is not open for trading.');
  }
  if (minutesLeft !== null && minutesLeft < MIN_MINUTES_TO_EXPIRY) {
    return refuse(409, 'market_closing', `This market closes in under ${MIN_MINUTES_TO_EXPIRY} minutes, too soon for a thesis to be audited.`);
  }

  if (options.now.getTime() - market.updatedAt.getTime() > MAX_QUOTE_AGE_MS) {
    return refuse(409, 'stale_price', 'Prices for this market are not updating right now. Try again in a minute.');
  }

  const side = checkSideAgainstPrice({
    side: input.side,
    probabilityYes: input.probabilityYes,
    yesBid: market.yesBid,
    yesAsk: market.yesAsk,
  });
  if (!side.ok) return refuse(409, side.code, side.message);

  const stake = toUnits(input.stakeUsd.toFixed(2));
  if (stake > toUnits(user.maxPerTradeUsd)) {
    return refuse(400, 'over_limit', `Your limit per trade is $${Number(user.maxPerTradeUsd).toFixed(2)}.`);
  }
  if (stake > toUnits(user.paperBalanceUsd)) {
    return refuse(409, 'insufficient_balance', `Your paper balance is $${Number(user.paperBalanceUsd).toFixed(2)}.`);
  }

  const ask = sideAsk(input.side, market);
  if (ask === null) return refuse(409, 'no_quote', `Nobody is selling ${input.side.toUpperCase()} on this market right now.`);
  const plan = planOrder({
    budgetUsd: fromUnits(stake),
    price: ask,
    quantityIncrement: market.quantityIncrement,
    quantityMinimum: market.quantityMinimum,
  });
  if (!plan.ok) return refuse(400, plan.code, plan.message);

  // The most the author will pay: a little above the price shown, but never more than
  // their own probability for the side, or the fill would contradict the thesis.
  const ownValue = input.side === 'yes' ? input.probabilityYes : 1 - input.probabilityYes;
  const ownCap = BigInt(Math.floor(ownValue * 100 + 1e-9)) * 100n;
  const withSlippage = toUnits(ask) + SLIPPAGE;
  const limit = withSlippage < ownCap ? withSlippage : ownCap;

  const author = await ensureHumanAuthor(db, user);
  if (await hasOpenThesis(db, author.id, market.id)) {
    return refuse(409, 'already_published', 'You already have a thesis on this market. One thesis per author per market.');
  }
  if ((await countAuditingTheses(db, author.id)) > 0) {
    return refuse(409, 'audit_in_progress', 'Your last thesis is still being audited. Wait for it to finish.');
  }
  const day = new Date(Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate()));
  if ((await countThesesSince(db, author.id, day)) >= MAX_THESES_PER_DAY) {
    return refuse(429, 'daily_limit', `You have submitted ${MAX_THESES_PER_DAY} theses today. Come back after midnight UTC.`);
  }

  const id = randomUUID();
  const content = { headline: input.headline, body: input.body, evidence: input.evidence };
  try {
    await createAuditingThesis(db, {
      id,
      onchainId: thesisOnchainId(id),
      contentHash: thesisContentHash({
        market: market.instrumentSymbol,
        side: input.side,
        probabilityYes: input.probabilityYes,
        ...content,
      }),
      authorId: author.id,
      userId: user.id,
      marketId: market.id,
      side: input.side,
      probabilityYes: input.probabilityYes.toFixed(4),
      ...content,
      limitPrice: fromUnits(limit),
      quantity: plan.quantity,
      stakeUsd: fromUnits(stake),
    });
  } catch (error) {
    // Two submissions arriving together both pass the checks above. The database's unique
    // indexes let exactly one through; the other lands here.
    console.error('thesis submission refused by the database', error instanceof Error ? error.message : error);
    return refuse(409, 'conflict', 'You already have a thesis being audited or published for this. Reload to see it.');
  }
  return { ok: true, data: { id, status: 'auditing' } };
}
