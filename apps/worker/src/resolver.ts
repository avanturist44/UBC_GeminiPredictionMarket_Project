import { AGENT_RULES, fromUnits, toUnits, type GeminiPublicClient } from '@thesis/core';
import {
  agentState,
  and,
  authors,
  eq,
  inArray,
  markets,
  sql,
  theses,
  trades,
  users,
  type Db,
  type MarketRecord,
} from '@thesis/db';
import type { Logger } from './recorder';

/**
 * Worker job 5, the resolver: when Gemini reports a contract's result, everything that
 * hangs on that market is settled.
 *
 * - The result is stored on the market. Only this job writes it, because payouts follow.
 * - Every public thesis on the market is marked right, wrong or void.
 * - Every open simulated position is paid: $1 a contract to the winning side, nothing to the
 *   losing side, the stake back if the market is void. People's paper balances are credited;
 *   an agent's profit or loss for the day is added to its record, and it is halted for the
 *   day if that takes it to a $50 loss.
 *
 * The result is only ever taken from Gemini's own `resolutionSide`. It is never inferred
 * from a price. Each market is settled in one transaction, guarded by the market's row, so
 * running this twice, or crashing halfway, pays nobody twice.
 *
 * Reporting the outcome to the escrow and paying or refunding tips is the on-chain half of
 * this job. It needs the deployed contract and is not wired in yet.
 */

export interface ResolverDeps {
  db: Db;
  client: Pick<GeminiPublicClient, 'getEvent'>;
  logger: Logger;
  now?: () => Date;
  /** Markets to ask Gemini about in one cycle. Each costs a request. */
  batch?: number;
}

export interface ResolverSummary {
  /** Markets Gemini was asked about. */
  checked: number;
  /** Markets that had a result and were settled. */
  resolved: number;
  /** Positions paid. */
  trades: number;
  /** Theses marked right, wrong or void. */
  theses: number;
}

const DAY_MS = 86_400_000;
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Expired tracked markets with no stored result, most pressing first: those somebody holds
 * a position or a thesis on, then the most recently expired. Markets more than a week past
 * expiry are left alone.
 */
async function candidates(db: Db, now: Date, limit: number): Promise<MarketRecord[]> {
  const nowIso = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const hasStake = sql<boolean>`(
    exists (select 1 from ${trades} where ${trades.marketId} = ${markets.id} and ${trades.status} in ('filled', 'partial'))
    or exists (select 1 from ${theses} where ${theses.marketId} = ${markets.id} and ${theses.status} = 'published')
  )`;
  return db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.tracked, true),
        sql`${markets.resolvedAt} is null`,
        sql`${markets.expiryAt} <= ${nowIso}::timestamptz`,
        sql`${markets.expiryAt} > ${weekAgo}::timestamptz`,
      ),
    )
    .orderBy(sql`${hasStake} desc`, sql`${markets.expiryAt} desc`)
    .limit(limit);
}

type Result = { voided: true; side: null; resolvedAt: Date } | { voided: false; side: 'yes' | 'no'; resolvedAt: Date };

async function settleMarket(
  db: Db,
  market: MarketRecord,
  result: Result,
  now: Date,
): Promise<{ trades: number; theses: number } | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(markets).where(eq(markets.id, market.id)).for('update');
    // Another run got here first.
    if (!locked || locked.resolvedAt !== null) return null;
    await tx
      .update(markets)
      .set({
        resolutionSide: result.side,
        resolvedAt: result.resolvedAt,
        status: result.voided ? 'invalid' : 'settled',
        marketState: 'closed',
      })
      .where(eq(markets.id, market.id));

    const open = await tx
      .select({ trade: trades, agentKey: authors.agentKey })
      .from(trades)
      .leftJoin(authors, eq(authors.id, trades.authorId))
      .where(and(eq(trades.marketId, market.id), inArray(trades.status, ['filled', 'partial'])))
      .for('update', { of: trades });

    /** Profit or loss per agent from this market. */
    const agentPnl = new Map<string, bigint>();
    for (const { trade, agentKey } of open) {
      const cost = toUnits(trade.costUsd);
      const payout = result.voided ? cost : trade.side === result.side ? toUnits(trade.quantity) : 0n;
      await tx.update(trades).set({ status: 'settled', payoutUsd: fromUnits(payout) }).where(eq(trades.id, trade.id));
      if (trade.userId) {
        // A person's position, their own thesis's or a copy: the payout goes to their balance.
        await tx
          .update(users)
          .set({ paperBalanceUsd: sql`${users.paperBalanceUsd} + ${fromUnits(payout)}::numeric` })
          .where(eq(users.id, trade.userId));
      } else if (agentKey) {
        agentPnl.set(agentKey, (agentPnl.get(agentKey) ?? 0n) + payout - cost);
      }
    }

    const day = dayOf(now);
    for (const [agentKey, pnl] of agentPnl) {
      await tx.insert(agentState).values({ agentKey, day }).onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(agentState)
        .where(and(eq(agentState.agentKey, agentKey), eq(agentState.day, day)))
        .for('update');
      if (!state) continue;
      const realized = toUnits(state.realizedPnlUsd) + pnl;
      const stillOpen = await tx
        .select({ cost: trades.costUsd })
        .from(trades)
        .innerJoin(authors, eq(authors.id, trades.authorId))
        .where(and(eq(authors.agentKey, agentKey), inArray(trades.status, ['filled', 'partial'])));
      const stopped = realized <= -toUnits(String(AGENT_RULES.dailyLossStopUsd));
      await tx
        .update(agentState)
        .set({
          realizedPnlUsd: fromUnits(realized),
          openExposureUsd: fromUnits(stillOpen.reduce((sum, row) => sum + toUnits(row.cost), 0n)),
          halted: state.halted || stopped,
          haltReason: state.haltReason ?? (stopped ? 'daily loss stop' : null),
        })
        .where(and(eq(agentState.agentKey, agentKey), eq(agentState.day, day)));
    }

    const live = await tx
      .select({ id: theses.id, side: theses.side })
      .from(theses)
      .where(and(eq(theses.marketId, market.id), eq(theses.status, 'published')));
    for (const thesis of live) {
      await tx
        .update(theses)
        .set({ status: 'resolved', outcome: result.voided ? 'void' : thesis.side === result.side ? 'right' : 'wrong' })
        .where(eq(theses.id, thesis.id));
    }
    return { trades: open.length, theses: live.length };
  });
}

export async function runResolverCycle(deps: ResolverDeps): Promise<ResolverSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const summary: ResolverSummary = { checked: 0, resolved: 0, trades: 0, theses: 0 };

  for (const market of await candidates(deps.db, now, deps.batch ?? 4)) {
    summary.checked += 1;
    try {
      const event = await deps.client.getEvent(market.eventTicker);
      const contract = event?.contracts.find((c) => c.instrumentSymbol === market.instrumentSymbol);
      if (!event || !contract) continue;
      const voided = event.status === 'invalid' || contract.status === 'invalid';
      const side = contract.resolutionSide ?? null;
      // No result yet. Gemini usually sets it a few seconds after expiry.
      if (!voided && side === null) continue;
      const reported = contract.resolvedAt ?? event.resolvedAt;
      const resolvedAt = reported && !Number.isNaN(Date.parse(reported)) ? new Date(reported) : now;
      const result: Result = voided || side === null ? { voided: true, side: null, resolvedAt } : { voided: false, side, resolvedAt };

      const settled = await settleMarket(deps.db, market, result, now);
      if (!settled) continue;
      summary.resolved += 1;
      summary.trades += settled.trades;
      summary.theses += settled.theses;
      if (settled.trades > 0 || settled.theses > 0) {
        deps.logger.info(
          `resolver: ${market.instrumentSymbol} ${result.voided ? 'void' : `resolved ${result.side}`}; ` +
            `paid ${settled.trades} positions, closed ${settled.theses} theses`,
        );
      }
    } catch (error) {
      // Retried on the next cycle. Nothing was half-written: each market is one transaction.
      deps.logger.error(`resolver: ${market.instrumentSymbol} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
