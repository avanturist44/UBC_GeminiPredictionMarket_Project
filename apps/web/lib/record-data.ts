import 'server-only';
import { AGENT_RULES, LIMIT_BOUNDS, checkLimitValue, type LimitName } from '@thesis/core';
import {
  getAccount,
  getAccountStats,
  getActivity,
  getAuthorStanding,
  getAuthorTheses,
  getLeaderboard,
  getPortfolioData,
  requestLimits,
  type AuthorStanding,
  type UserRow,
} from '@thesis/db';
import { z } from 'zod';
import { getDb } from './db';
import type { Loaded } from './market-data';
import { PORTFOLIO_SLOTS, buildPortfolio } from './portfolio';
import type {
  AccountResponse,
  ActivityResponse,
  AuthorResponse,
  LeaderboardResponse,
  LeaderboardRow,
} from './record-view';
import { NOT_CONFIGURED, UUID, dbError, toMe } from './thesis-data';
import { toThesisCard } from './thesis-mapping';
import type { MeResponse } from './thesis-view';

/** Loads the leaderboard, author pages, the live strip and the account page. */

const toRow = (standing: AuthorStanding): LeaderboardRow => ({
  id: standing.author.id,
  name: standing.author.displayName,
  kind: standing.author.kind,
  record: standing.record,
  profitUsd: standing.profitUsd,
  theses: standing.theses,
});

export async function loadLeaderboard(): Promise<Loaded<LeaderboardResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    return { ok: true, data: { asOf: new Date().toISOString(), authors: (await getLeaderboard(db)).map(toRow) } };
  } catch (error) {
    return dbError(error);
  }
}

const cents = (price: number) => `${Math.round(price * 100)}¢`;

/** The limits every agent trades within, as shown on its profile. */
const AGENT_LIMITS: Array<{ label: string; value: string }> = [
  { label: 'Starting bankroll', value: `$${AGENT_RULES.bankrollUsd.toLocaleString('en-US')} of test funds` },
  { label: 'Most per trade', value: `$${AGENT_RULES.maxPerTradeUsd}` },
  { label: 'Most open at once', value: `$${AGENT_RULES.maxOpenExposureUsd} across all positions` },
  { label: 'Daily loss stop', value: `Halts for the day after losing $${AGENT_RULES.dailyLossStopUsd}` },
  { label: 'Trades per day', value: `${AGENT_RULES.maxTradesPerDay}` },
  { label: 'Prices it will pay', value: `${cents(AGENT_RULES.minPrice)} to ${cents(AGENT_RULES.maxPrice)}` },
  { label: 'Widest spread', value: cents(AGENT_RULES.maxSpread) },
  { label: 'Time left on the market', value: `At least ${AGENT_RULES.minMinutesToExpiry} minutes` },
];

export async function loadAuthor(id: string): Promise<Loaded<AuthorResponse>> {
  const notFound: Loaded<never> = {
    ok: false,
    status: 404,
    error: { code: 'not_found', message: 'There is no author at this address.' },
  };
  if (!UUID.test(id)) return notFound;
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const [standing, views] = await Promise.all([getAuthorStanding(db, id, new Date()), getAuthorTheses(db, id)]);
    if (!standing) return notFound;
    const isAgent = standing.author.kind === 'agent';
    return {
      ok: true,
      data: {
        asOf: new Date().toISOString(),
        author: {
          ...toRow(standing),
          strategySummary: standing.author.strategySummary,
          agentStatus: standing.agentStatus,
          limits: isAgent ? AGENT_LIMITS : [],
        },
        theses: views.map((view) => toThesisCard(view)),
      },
    };
  } catch (error) {
    return dbError(error);
  }
}

export async function loadActivity(): Promise<Loaded<ActivityResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const items = await getActivity(db, 8);
    return {
      ok: true,
      data: {
        asOf: new Date().toISOString(),
        items: items.map((item) => ({
          tipId: item.tipId,
          status: item.status,
          amountUsdc: item.amountUsdc,
          settleTx: item.settleTx,
          thesisId: item.thesisId,
          outcome: item.outcome,
          authorName: item.authorName,
          marketTitle: item.marketTitle,
          at: item.at.toISOString(),
        })),
      },
    };
  } catch (error) {
    return dbError(error);
  }
}

export async function loadAccount(user: UserRow): Promise<Loaded<AccountResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const now = new Date();
    const [me, account, portfolioData, stats] = await Promise.all([
      toMe(user),
      getAccount(db, user.id),
      getPortfolioData(db, user.id, { now, slots: PORTFOLIO_SLOTS }),
      getAccountStats(db, user.id),
    ]);
    const portfolio = buildPortfolio(portfolioData, { now, cashUsd: Number(user.paperBalanceUsd) });
    return {
      ok: true,
      data: {
        ...me,
        asOf: now.toISOString(),
        joinedAt: user.createdAt.toISOString(),
        portfolio: portfolio.view,
        stats,
        positions: account.positions.map((p) => ({
          tradeId: p.tradeId,
          thesisId: p.thesisId,
          headline: p.headline,
          marketSymbol: p.marketSymbol,
          marketTitle: p.marketTitle,
          contractLabel: p.contractLabel,
          expiryAt: p.expiryAt?.toISOString() ?? null,
          own: p.isAuthorPosition,
          side: p.side,
          quantity: p.quantity,
          price: p.price,
          costUsd: p.costUsd,
          payoutUsd: p.payoutUsd,
          settled: p.status === 'settled',
          markPrice: portfolio.marks.get(p.tradeId)?.markPrice ?? null,
          valueUsd: portfolio.marks.get(p.tradeId)?.valueUsd ?? null,
        })),
        tips: account.tips.map((t) => ({
          tipId: t.tipId,
          thesisId: t.thesisId,
          headline: t.headline,
          amountUsdc: t.amountUsdc,
          status: t.status,
          depositTx: t.depositTx,
          settleTx: t.settleTx,
        })),
      },
    };
  } catch (error) {
    return dbError(error);
  }
}

const LimitsBody = z
  .object({ maxPerTradeUsd: z.number().optional(), dailyCopyCapUsd: z.number().optional() })
  .refine((body) => body.maxPerTradeUsd !== undefined || body.dailyCopyCapUsd !== undefined);

/**
 * Changes the signed-in user's limits. A lower limit applies at once; a higher one waits
 * for the next UTC day. Both must stay inside the range the app allows.
 */
export async function changeLimits(user: UserRow, body: unknown, now: Date): Promise<Loaded<MeResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  const parsed = LimitsBody.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'invalid',
        message: `Send maxPerTradeUsd ($${LIMIT_BOUNDS.maxPerTradeUsd.min} to $${LIMIT_BOUNDS.maxPerTradeUsd.max}), dailyCopyCapUsd ($${LIMIT_BOUNDS.dailyCopyCapUsd.min} to $${LIMIT_BOUNDS.dailyCopyCapUsd.max}), or both, as numbers.`,
      },
    };
  }
  const wanted: Partial<Record<LimitName, string>> = {};
  for (const name of ['maxPerTradeUsd', 'dailyCopyCapUsd'] as const) {
    const value = parsed.data[name];
    if (value === undefined) continue;
    const check = checkLimitValue(name, value);
    if (!check.ok) return { ok: false, status: 400, error: { code: check.code, message: check.message } };
    wanted[name] = value.toFixed(2);
  }
  try {
    return { ok: true, data: await toMe(await requestLimits(db, user, wanted, now)) };
  } catch (error) {
    return dbError(error);
  }
}
