import {
  AGENT_RULES,
  LlmError,
  MIN_STAKE_USD,
  auditThesis,
  checkAgentEntry,
  fromUnits,
  planOrder,
  sideAsk,
  toUnits,
  yesMidpoint,
  type AuditResult,
  type Llm,
} from '@thesis/core';
import {
  agentRuns,
  agentState,
  and,
  asc,
  audits,
  authors,
  desc,
  eq,
  inArray,
  isNull,
  markets,
  ne,
  theses,
  trades,
  users,
  type AuthorRow,
  type Db,
  type MarketRecord,
  type ThesisRow,
} from '@thesis/db';
import type { Logger } from './recorder';

/**
 * Worker job 3 and the thesis pipeline: every thesis waiting in `auditing`, from a person or
 * an agent, is audited and then either blocked, sent back, or published with its author's
 * position filled.
 *
 * - Blocked: the auditor found inside information or prohibited content. Nothing is traded.
 * - Sent back to draft: the audit passed but the author's trade could not be placed as they
 *   asked (the price moved past their limit, the market closed, a limit was hit). Nothing is
 *   charged, and the reason is stored on the rejected trade.
 * - Published: the trade is filled at the current price and the thesis goes live, in one
 *   database transaction, so a thesis can never be public without its author's position.
 *
 * All fills here are simulated ("paper"): test money at Gemini's live price. Whether a
 * trade happens, its side, size and price are decided in this file from numbers the author
 * or agent committed to before the audit. The auditor's model has no say in any of them.
 *
 * On-chain registration (Phase 4) belongs between the fill and the publish.
 */

export interface BookQuote {
  yesBid: string | null;
  yesAsk: string | null;
  bidSize: string | null;
  askSize: string | null;
  /** When the stream delivered it, in milliseconds. */
  at: number;
}

export interface PipelineDeps {
  db: Db;
  /** Null when no model is configured: the auditor then runs its phrase screen only. */
  llm: Llm | null;
  /** The stream's live top of book for a symbol, with sizes. */
  book?: (instrumentSymbol: string) => BookQuote | undefined;
  tradingEnabled: () => boolean;
  logger: Logger;
  now?: () => Date;
}

export interface PipelineSummary {
  published: number;
  blocked: number;
  /** Audited and sent back to draft because the trade could not be placed. */
  returned: number;
  /** Still waiting: an audit failed and will be tried again, or trading is switched off. */
  waiting: number;
  /** Already-public theses that had no audit and now have one. */
  backfilled: number;
}

export interface ThesisPipeline {
  runCycle(): Promise<PipelineSummary>;
}

const BOOK_MAX_AGE_MS = 15_000;
/** A stored quote older than this is not a price: the recorder has stopped. */
const STORED_QUOTE_MAX_AGE_MS = 120_000;
const HUMAN_MIN_MINUTES_TO_EXPIRY = 2;
const MAX_AUDIT_ATTEMPTS = 5;
const BATCH = 5;

interface Waiting {
  thesis: ThesisRow;
  author: AuthorRow;
  market: MarketRecord;
}

type Outcome =
  | { kind: 'published'; quantity: string; price: string; costUsd: string }
  | { kind: 'returned'; reason: string }
  | { kind: 'waiting' }
  | { kind: 'gone' };

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

function auditInput(row: Waiting, now: Date) {
  return {
    thesis: {
      headline: row.thesis.headline,
      body: row.thesis.body,
      side: row.thesis.side,
      probabilityYes: Number(row.thesis.probabilityYes),
      evidence: row.thesis.evidence,
    },
    market: {
      symbol: row.market.instrumentSymbol,
      title: row.market.title,
      contractLabel: row.market.contractLabel,
      expiryAt: row.market.expiryAt,
      strike: row.market.strike,
      yesBid: row.market.yesBid,
      yesAsk: row.market.yesAsk,
      lastPrice: row.market.lastPrice,
    },
    now,
  };
}

export function createThesisPipeline(deps: PipelineDeps): ThesisPipeline {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());
  /** Audit failures per thesis, so a failing one is retried with a growing wait, then given up. */
  const failures = new Map<string, { count: number; retryAt: number }>();

  /** The thesis's audit: the one it has, one already done for identical content, or a new one. */
  async function auditOf(
    row: Waiting,
    options: { late?: boolean } = {},
  ): Promise<Pick<AuditResult, 'verdict' | 'blockReason'>> {
    const [existing] = await db
      .select()
      .from(audits)
      .where(eq(audits.thesisId, row.thesis.id))
      .orderBy(desc(audits.createdAt))
      .limit(1);
    if (existing) return existing;

    // The same text on the same market and side has the same hash: reuse that audit.
    const [cached] = row.thesis.contentHash
      ? await db
          .select({ audit: audits })
          .from(audits)
          .innerJoin(theses, eq(theses.id, audits.thesisId))
          .where(and(eq(theses.contentHash, row.thesis.contentHash), ne(theses.id, row.thesis.id)))
          .orderBy(desc(audits.createdAt))
          .limit(1)
      : [];
    const result: AuditResult = cached
      ? {
          verdict: cached.audit.verdict,
          insideInfo: cached.audit.insideInfo,
          blockReason: cached.audit.blockReason,
          claims: cached.audit.claims,
          model: cached.audit.model ?? 'unknown',
        }
      : await auditThesis(auditInput(row, now()), deps.llm);
    // A thesis that is already public, with its author's position filled, cannot be blocked
    // after the fact. What would have blocked it is recorded as a flag, with the reason.
    if (options.late && result.verdict === 'blocked') result.verdict = 'flagged';
    await db.insert(audits).values({
      thesisId: row.thesis.id,
      verdict: result.verdict,
      claims: result.claims,
      insideInfo: result.insideInfo,
      blockReason: result.blockReason,
      model: result.model,
    });
    return result;
  }

  async function logAgentRun(row: Waiting, decision: 'trade' | 'skip', reason: string, signal: Record<string, unknown>) {
    if (row.author.kind !== 'agent' || !row.author.agentKey) return;
    await db.insert(agentRuns).values({
      agentKey: row.author.agentKey,
      marketId: row.market.id,
      decision,
      reason,
      signal: { thesisId: row.thesis.id, ...signal },
    });
  }

  async function block(row: Waiting, reason: string | null): Promise<void> {
    const rejectReason = reason ?? 'The thesis was blocked by the audit.';
    await db.transaction(async (tx) => {
      await tx
        .update(theses)
        .set({ status: 'blocked' })
        .where(and(eq(theses.id, row.thesis.id), eq(theses.status, 'auditing')));
      await tx
        .update(trades)
        .set({ status: 'rejected', rejectReason })
        .where(and(eq(trades.thesisId, row.thesis.id), eq(trades.status, 'pending')));
    });
    await logAgentRun(row, 'skip', `Blocked by the audit: ${rejectReason}`, {});
  }

  /** Fills the author's trade and publishes, or sends the thesis back, in one transaction. */
  async function settle(row: Waiting): Promise<Outcome> {
    if (!deps.tradingEnabled()) return { kind: 'waiting' };
    const at = now();

    return db.transaction(async (tx): Promise<Outcome> => {
      // Serializes everything this author does, across theses and worker processes.
      await tx.select({ id: authors.id }).from(authors).where(eq(authors.id, row.author.id)).for('update');
      const [thesis] = await tx
        .select()
        .from(theses)
        .where(and(eq(theses.id, row.thesis.id), eq(theses.status, 'auditing')))
        .for('update');
      const [trade] = await tx
        .select()
        .from(trades)
        .where(and(eq(trades.thesisId, row.thesis.id), eq(trades.isAuthorPosition, true), eq(trades.status, 'pending')))
        .for('update');
      const [market] = await tx.select().from(markets).where(eq(markets.id, row.market.id));
      if (!thesis || !trade || !market) return { kind: 'gone' };

      const sendBack = async (reason: string): Promise<Outcome> => {
        await tx.update(theses).set({ status: 'draft' }).where(eq(theses.id, thesis.id));
        await tx.update(trades).set({ status: 'rejected', rejectReason: reason }).where(eq(trades.id, trade.id));
        return { kind: 'returned', reason };
      };

      const isAgent = row.author.kind === 'agent';
      const minutesLeft = market.expiryAt ? (market.expiryAt.getTime() - at.getTime()) / 60_000 : null;
      const minMinutes = isAgent ? AGENT_RULES.minMinutesToExpiry : HUMAN_MIN_MINUTES_TO_EXPIRY;
      if (market.marketState !== 'open' || market.resolutionSide !== null) {
        return sendBack('The market is no longer open for trading.');
      }
      if (minutesLeft !== null && minutesLeft < minMinutes) {
        return sendBack(`The market closes in under ${minMinutes} minutes.`);
      }

      // Prefer the stream's book, which has sizes. The market row is at most a second or two
      // behind it and has none, so a fill from the row is not limited by size.
      const live = deps.book?.(market.instrumentSymbol);
      const fresh = live && at.getTime() - live.at <= BOOK_MAX_AGE_MS ? live : undefined;
      // With no live book and a stored quote that has stopped updating there is no price to
      // fill at. Wait for prices to come back; the thesis stays where it is, uncharged.
      if (!fresh && at.getTime() - market.updatedAt.getTime() > STORED_QUOTE_MAX_AGE_MS) return { kind: 'waiting' };
      const quote = fresh ?? { yesBid: market.yesBid, yesAsk: market.yesAsk, bidSize: null, askSize: null };
      const ask = sideAsk(thesis.side, quote);
      if (ask === null) return sendBack(`Nobody is selling ${thesis.side.toUpperCase()} right now.`);
      if (toUnits(ask) > toUnits(trade.price)) {
        return sendBack(
          `The price moved to ${ask}, above the most this thesis would pay (${fromUnits(toUnits(trade.price))}).`,
        );
      }

      // Buying YES takes the ask's size; buying NO takes the bid's.
      const available = thesis.side === 'yes' ? quote.askSize : quote.bidSize;
      const contract = { quantityIncrement: market.quantityIncrement, quantityMinimum: market.quantityMinimum };
      const wanted = planOrder({ budgetUsd: trade.costUsd, price: ask, ...contract });
      const plan = planOrder({ budgetUsd: trade.costUsd, price: ask, ...contract, availableQuantity: available });
      if (!plan.ok) return sendBack(plan.message);
      const partial = wanted.ok && toUnits(plan.quantity) < toUnits(wanted.quantity);
      const cost = toUnits(plan.costUsd);
      // An author must hold a real position. A book too thin for the minimum stake is no fill.
      if (partial && cost < toUnits(String(MIN_STAKE_USD))) {
        return sendBack(`Too little ${thesis.side.toUpperCase()} is on offer at this price to place the minimum stake of $${MIN_STAKE_USD}.`);
      }

      if (isAgent) {
        const mine = await tx.select().from(trades).where(and(eq(trades.authorId, row.author.id), eq(trades.mode, 'paper')));
        const open = mine.filter((t) => t.status === 'filled' || t.status === 'partial');
        const exposure = open.reduce((sum, t) => sum + toUnits(t.costUsd), 0n);
        const settledPnl = mine
          .filter((t) => t.status === 'settled')
          .reduce((sum, t) => sum + toUnits(t.payoutUsd ?? '0') - toUnits(t.costUsd), 0n);
        const balance = toUnits(String(AGENT_RULES.bankrollUsd)) + settledPnl - exposure;
        const day = dayOf(at);
        const key = row.author.agentKey!;
        await tx.insert(agentState).values({ agentKey: key, day }).onConflictDoNothing();
        const [state] = await tx
          .select()
          .from(agentState)
          .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)))
          .for('update');
        if (!state) throw new Error(`agent state missing for ${key}`);

        const allowed = checkAgentEntry({
          halted: state.halted,
          haltReason: state.haltReason,
          realizedPnlTodayUsd: Number(state.realizedPnlUsd),
          openExposureUsd: Number(fromUnits(exposure)),
          tradesToday: state.tradeCount,
          hasPositionOnMarket: mine.some(
            (t) => t.marketId === market.id && t.id !== trade.id && t.status !== 'rejected',
          ),
          balanceUsd: Number(fromUnits(balance)),
          costUsd: Number(plan.costUsd),
          price: Number(ask),
          spread: quote.yesBid !== null && quote.yesAsk !== null ? Number(quote.yesAsk) - Number(quote.yesBid) : null,
          minutesToExpiry: minutesLeft,
        });
        if (!allowed.ok) {
          if (allowed.code === 'daily_loss_stop' && !state.halted) {
            await tx
              .update(agentState)
              .set({ halted: true, haltReason: 'daily loss stop' })
              .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
          }
          return sendBack(allowed.message);
        }
        await tx
          .update(agentState)
          .set({ tradeCount: state.tradeCount + 1, openExposureUsd: fromUnits(exposure + cost) })
          .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
      } else {
        if (!trade.userId) return sendBack('This thesis has no account to trade from.');
        const [user] = await tx.select().from(users).where(eq(users.id, trade.userId)).for('update');
        if (!user) return sendBack('This thesis has no account to trade from.');
        const balance = toUnits(user.paperBalanceUsd);
        if (cost > balance) {
          return sendBack(`The paper balance of $${fromUnits(balance)} does not cover a stake of $${plan.costUsd}.`);
        }
        await tx.update(users).set({ paperBalanceUsd: fromUnits(balance - cost) }).where(eq(users.id, user.id));
      }

      await tx
        .update(trades)
        .set({ status: partial ? 'partial' : 'filled', quantity: plan.quantity, price: ask, costUsd: plan.costUsd })
        .where(eq(trades.id, trade.id));

      const mid = yesMidpoint({ bid: quote.yesBid, ask: quote.yesAsk });
      await tx
        .update(theses)
        .set({
          status: 'published',
          publishedAt: at,
          entryPrice: ask,
          marketYesPriceAtPublish: mid !== null ? mid.toFixed(4) : (quote.yesAsk ?? quote.yesBid),
        })
        .where(eq(theses.id, thesis.id));
      return { kind: 'published', quantity: plan.quantity, price: ask, costUsd: plan.costUsd };
    });
  }

  /** Sends a thesis back to draft without a trade, for a reason that is not its author's doing. */
  async function giveUp(row: Waiting, rejectReason: string, logReason: string): Promise<void> {
    failures.delete(row.thesis.id);
    await db.transaction(async (tx) => {
      await tx.update(theses).set({ status: 'draft' }).where(and(eq(theses.id, row.thesis.id), eq(theses.status, 'auditing')));
      await tx
        .update(trades)
        .set({ status: 'rejected', rejectReason })
        .where(and(eq(trades.thesisId, row.thesis.id), eq(trades.status, 'pending')));
    });
    await logAgentRun(row, 'skip', logReason, {});
  }

  /**
   * Counts a failure of this thesis. True when it has now failed too often and was given up
   * on, so one thesis that cannot be handled never holds up the ones behind it.
   */
  async function failed(row: Waiting, stage: 'audit' | 'publish', message: string): Promise<boolean> {
    const count = (failures.get(row.thesis.id)?.count ?? 0) + 1;
    if (count >= MAX_AUDIT_ATTEMPTS) {
      const what = stage === 'audit' ? 'The audit could not be completed' : 'The thesis could not be published';
      await giveUp(row, `${what}. Nothing was charged; submit again later.`, `Gave up after ${count} failed attempts: ${message}`);
      logger.error(`pipeline: gave up on thesis ${row.thesis.id} at ${stage}: ${message}`);
      return true;
    }
    failures.set(row.thesis.id, { count, retryAt: now().getTime() + Math.min(30_000 * 2 ** (count - 1), 300_000) });
    logger.warn(`pipeline: ${stage} of thesis ${row.thesis.id} failed, will retry: ${message}`);
    return false;
  }

  /** Handles one waiting thesis. */
  async function process(row: Waiting, summary: PipelineSummary): Promise<void> {
    const earlier = failures.get(row.thesis.id);
    if (earlier && now().getTime() < earlier.retryAt) {
      summary.waiting += 1;
      return;
    }

    let audit: Pick<AuditResult, 'verdict' | 'blockReason'>;
    try {
      audit = await auditOf(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LlmError && error.code === 'budget') {
        // The day's model budget is spent. Waiting until midnight would lock the author out,
        // so the thesis goes back to them now, uncharged.
        await giveUp(
          row,
          'The auditor has reached its daily limit. Nothing was charged; submit again after midnight UTC.',
          'The daily language-model cap is reached.',
        );
        summary.returned += 1;
        return;
      }
      if (await failed(row, 'audit', message)) summary.returned += 1;
      else summary.waiting += 1;
      return;
    }

    if (audit.verdict === 'blocked') {
      failures.delete(row.thesis.id);
      await block(row, audit.blockReason);
      summary.blocked += 1;
      return;
    }

    let outcome: Outcome;
    try {
      outcome = await settle(row);
    } catch (error) {
      if (await failed(row, 'publish', error instanceof Error ? error.message : String(error))) summary.returned += 1;
      else summary.waiting += 1;
      return;
    }
    failures.delete(row.thesis.id);
    if (outcome.kind === 'published') {
      summary.published += 1;
      await logAgentRun(row, 'trade', `Published after the audit (${audit.verdict}). Simulated fill at Gemini's live price; zero fees.`, {
        verdict: audit.verdict,
        fill: outcome,
      });
    } else if (outcome.kind === 'returned') {
      summary.returned += 1;
      await logAgentRun(row, 'skip', `Audit ${audit.verdict}, but no trade: ${outcome.reason}`, { verdict: audit.verdict });
    } else if (outcome.kind === 'waiting') {
      summary.waiting += 1;
    }
  }

  /** Audits public theses that have no audit, such as ones another job published directly. */
  async function backfill(summary: PipelineSummary): Promise<void> {
    const rows = await db
      .select({ thesis: theses, author: authors, market: markets })
      .from(theses)
      .innerJoin(authors, eq(authors.id, theses.authorId))
      .innerJoin(markets, eq(markets.id, theses.marketId))
      .leftJoin(audits, eq(audits.thesisId, theses.id))
      .where(and(inArray(theses.status, ['published', 'resolved']), isNull(audits.id)))
      .orderBy(desc(theses.publishedAt))
      .limit(2);
    for (const row of rows) {
      const failed = failures.get(row.thesis.id);
      if (failed && now().getTime() < failed.retryAt) continue;
      try {
        await auditOf(row, { late: true });
        failures.delete(row.thesis.id);
        summary.backfilled += 1;
      } catch (error) {
        const count = (failed?.count ?? 0) + 1;
        failures.set(row.thesis.id, { count, retryAt: now().getTime() + Math.min(60_000 * 2 ** (count - 1), 3_600_000) });
        logger.warn(`pipeline: audit of published thesis ${row.thesis.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    async runCycle() {
      const summary: PipelineSummary = { published: 0, blocked: 0, returned: 0, waiting: 0, backfilled: 0 };
      const waiting = await db
        .select({ thesis: theses, author: authors, market: markets })
        .from(theses)
        .innerJoin(authors, eq(authors.id, theses.authorId))
        .innerJoin(markets, eq(markets.id, theses.marketId))
        .where(eq(theses.status, 'auditing'))
        .orderBy(asc(theses.createdAt))
        .limit(BATCH);
      for (const row of waiting) {
        try {
          await process(row, summary);
        } catch (error) {
          // One thesis failing in the database must not stop the others.
          summary.waiting += 1;
          logger.error(`pipeline: thesis ${row.thesis.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // New submissions come first; old gaps are filled only when the queue is empty.
      if (waiting.length === 0) await backfill(summary);
      return summary;
    },
  };
}
