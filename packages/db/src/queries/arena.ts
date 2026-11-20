import { ARENA_ROSTER } from '@thesis/core';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { agentRuns, authors, markets, sandboxOrders, theses, type SandboxOrderStatus } from '../schema';
import { getRaceData, type RaceData, type RaceRun } from './race';

/**
 * What the model arena needs: the race data of every roster model (its own positions, the
 * markets they are on and their slot-thinned prices), each model's latest looks with the
 * headline of the thesis a look sent, and each model's payout wallet.
 */

export type ArenaRun = RaceRun & {
  /** The thesis a look sent to the auditor, when it traded. */
  thesisHeadline: string | null;
  /** Google's search suggestions, shown with a grounded answer. Only Gemini has them. */
  searchSuggestionsHtml: string | null;
};

/**
 * What the sandbox exchange did with a trade's mirror order. Only the outcome: the order id,
 * client order id, error code and anything about the account stay in the database.
 */
export interface ArenaExchange {
  status: SandboxOrderStatus;
  filledQuantity: string | null;
  sandboxPrice: string | null;
}

export interface ArenaData extends RaceData {
  /** The mirror order of each trade that has one, keyed by trade id. */
  exchanges: Map<string, ArenaExchange>;
  /** Newest first, keyed by agent key. */
  runs: Map<string, ArenaRun[]>;
  /** The author's wallet address, or null before it has one, keyed by agent key. */
  wallets: Map<string, string | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getArenaData(
  db: Db,
  options: { now: Date; slots: number; runsPerAgent: number },
): Promise<ArenaData> {
  const keys = ARENA_ROSTER.map((e) => e.agentKey);
  const race = await getRaceData(db, keys, { now: options.now, slots: options.slots });

  const walletRows = await db
    .select({ agentKey: authors.agentKey, walletAddress: authors.walletAddress })
    .from(authors)
    .where(and(eq(authors.kind, 'agent'), inArray(authors.agentKey, keys)));
  const wallets = new Map<string, string | null>(keys.map((key) => [key, null]));
  for (const row of walletRows) if (row.agentKey) wallets.set(row.agentKey, row.walletAddress);

  const tradeIds = race.agents.flatMap((agent) => agent.trades.map((t) => t.id));
  const exchanges = new Map<string, ArenaExchange>();
  if (tradeIds.length > 0) {
    const rows = await db
      .select({
        tradeId: sandboxOrders.tradeId,
        status: sandboxOrders.status,
        filledQuantity: sandboxOrders.filledQuantity,
        sandboxPrice: sandboxOrders.sandboxPrice,
      })
      .from(sandboxOrders)
      .where(inArray(sandboxOrders.tradeId, tradeIds));
    for (const { tradeId, ...exchange } of rows) exchanges.set(tradeId, exchange);
  }

  const runRows = await Promise.all(
    keys.map((key) =>
      db
        .select({
          decision: agentRuns.decision,
          reason: agentRuns.reason,
          createdAt: agentRuns.createdAt,
          marketTitle: markets.title,
          contractLabel: markets.contractLabel,
          thesisId: sql<string | null>`${agentRuns.signal} ->> 'thesisId'`,
          searchSuggestionsHtml: sql<string | null>`${agentRuns.signal} ->> 'searchSuggestionsHtml'`,
        })
        .from(agentRuns)
        .leftJoin(markets, eq(markets.id, agentRuns.marketId))
        .where(and(eq(agentRuns.agentKey, key), lte(agentRuns.createdAt, options.now)))
        .orderBy(desc(agentRuns.createdAt))
        .limit(options.runsPerAgent),
    ),
  );

  // The signal is free-form JSON: only a well-formed id is looked up.
  const thesisIds = [...new Set(runRows.flat().flatMap((row) => (row.thesisId && UUID.test(row.thesisId) ? [row.thesisId] : [])))];
  const headlines = new Map<string, string>();
  if (thesisIds.length > 0) {
    const rows = await db.select({ id: theses.id, headline: theses.headline }).from(theses).where(inArray(theses.id, thesisIds));
    for (const row of rows) headlines.set(row.id, row.headline);
  }

  const runs = new Map<string, ArenaRun[]>();
  keys.forEach((key, i) => {
    runs.set(
      key,
      runRows[i]!.map(({ thesisId, ...row }) => ({
        ...row,
        thesisHeadline: (thesisId && headlines.get(thesisId.toLowerCase())) || null,
        searchSuggestionsHtml: row.searchSuggestionsHtml || null,
      })),
    );
  });

  return { ...race, runs, wallets, exchanges };
}
