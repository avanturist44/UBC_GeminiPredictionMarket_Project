import { randomUUID } from 'node:crypto';
import {
  AGENT_RULES,
  dataBlock,
  decideNews,
  planOrder,
  sideAsk,
  thesisContentHash,
  thesisOnchainId,
  type AgentDecision,
  type NewsEstimate,
} from '@thesis/core';
import {
  agentRuns,
  agentState,
  and,
  asc,
  createAuditingThesis,
  eq,
  inArray,
  markets,
  sql,
  theses,
  type AuthorRow,
  type Db,
  type Evidence,
  type MarketRecord,
} from '@thesis/db';

/**
 * What the agents that read have in common: the `news` and `fade` agents (agents.ts) and the
 * model arena (arena.ts). How a market is shown to a model, which markets are open, what an
 * agent has looked at or holds, whether it is halted, how a cycle is logged, and how a trade
 * is handed to the thesis pipeline.
 */

export interface AgentCycle {
  market: string | null;
  decision: 'trade' | 'skip';
  reason: string;
}

export const GEMINI_EVENT_URL = 'https://www.gemini.com/predictions/';
export const HOUR = 3_600_000;

export const NEWS_SYSTEM = `You estimate the probability that a prediction market contract resolves YES, for an agent that publishes its reasoning.

Search the web for current, reliable reporting and data on the question. Then return:
- probability_yes: your probability that the contract resolves YES, from the evidence. Do not anchor on the market price you are shown.
- confidence: "low" if the evidence is thin, stale or conflicting; otherwise "medium" or "high".
- headline: one line, at most 90 characters, stating your view.
- body: at most 1,200 characters of plain prose arguing that view from what the sources say. State facts you can source. Do not give trading advice, a position size or a price target.
- evidence: two to six sources you actually read, each with a one-sentence statement of what it shows and its web address.
- no_trade_reason: a sentence if the question is ambiguous, cannot be researched, or you would not stand behind a number; otherwise null.

You only estimate and explain. Whether to trade, which side, how much and at what price are decided elsewhere.`;

export const cents = (price: number) => `${Math.round(Math.round(price * 10_000) / 100)}¢`;

export function describeMarket(market: MarketRecord, now: Date): string {
  return dataBlock(
    'market',
    [
      `Question: ${market.title}`,
      market.contractLabel ? `Contract: ${market.contractLabel} (resolves YES if this outcome happens)` : null,
      market.strike ? `Strike: ${market.strike}` : null,
      market.category ? `Category: ${market.category}` : null,
      market.expiryAt ? `Resolves at: ${market.expiryAt.toISOString()}` : null,
      `Market page: ${GEMINI_EVENT_URL}${market.eventTicker}`,
      `Time now: ${now.toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** The question the `news` strategy puts to a model about a market: the market, and its price for reference. */
export function newsQuestion(market: MarketRecord, now: Date): string {
  return `${describeMarket(market, now)}\n\nFor reference only, YES currently costs ${cents(Number(market.yesAsk))} to buy.`;
}

/** Tracked, open contracts with at least `minMsLeft` to run. */
export async function openMarkets(db: Db, now: Date, minMsLeft: number): Promise<MarketRecord[]> {
  const cutoff = new Date(now.getTime() + minMsLeft).toISOString();
  return db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.tracked, true),
        eq(markets.marketState, 'open'),
        sql`${markets.resolutionSide} is null`,
        sql`(${markets.expiryAt} is null or ${markets.expiryAt} > ${cutoff}::timestamptz)`,
      ),
    )
    .orderBy(asc(markets.instrumentSymbol));
}

/** Markets the agent already has a live or waiting thesis on. */
export async function marketsWithThesis(db: Db, authorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ marketId: theses.marketId })
    .from(theses)
    .where(and(eq(theses.authorId, authorId), inArray(theses.status, ['auditing', 'published', 'resolved'])));
  return new Set(rows.map((row) => row.marketId));
}

/** When the agent last looked at each market. */
export async function lastLooks(db: Db, agentKey: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ marketId: agentRuns.marketId, at: sql<Date>`max(${agentRuns.createdAt})`.mapWith(agentRuns.createdAt) })
    .from(agentRuns)
    .where(eq(agentRuns.agentKey, agentKey))
    .groupBy(agentRuns.marketId);
  return new Map(rows.filter((r) => r.marketId !== null).map((r) => [r.marketId!, r.at.getTime()]));
}

export async function isHalted(db: Db, agentKey: string, now: Date): Promise<string | null> {
  const [state] = await db
    .select()
    .from(agentState)
    .where(and(eq(agentState.agentKey, agentKey), eq(agentState.day, now.toISOString().slice(0, 10))));
  return state?.halted ? (state.haltReason ?? 'stopped') : null;
}

export async function logRun(
  db: Db,
  agentKey: string,
  market: MarketRecord | null,
  cycle: Pick<AgentCycle, 'decision' | 'reason'>,
  signal: Record<string, unknown> = {},
  error?: string,
): Promise<AgentCycle> {
  await db.insert(agentRuns).values({
    agentKey,
    marketId: market?.id ?? null,
    decision: cycle.decision,
    reason: cycle.reason,
    signal,
    error: error ?? null,
  });
  return { market: market?.instrumentSymbol ?? null, ...cycle };
}

/** Stores the agent's thesis as `auditing` with its intended position. The pipeline does the rest. */
export async function submit(
  db: Db,
  author: AuthorRow,
  market: MarketRecord,
  decision: Extract<AgentDecision, { decision: 'trade' }>,
  content: { headline: string; body: string; evidence: Evidence[] },
): Promise<{ ok: true; thesisId: string } | { ok: false; reason: string }> {
  const ask = sideAsk(decision.side, market);
  if (ask === null) return { ok: false, reason: 'Nobody is selling that side.' };
  const plan = planOrder({
    budgetUsd: String(AGENT_RULES.stakeUsd),
    price: ask,
    quantityIncrement: market.quantityIncrement,
    quantityMinimum: market.quantityMinimum,
  });
  if (!plan.ok) return { ok: false, reason: plan.message };
  const id = randomUUID();
  await createAuditingThesis(db, {
    id,
    onchainId: thesisOnchainId(id),
    contentHash: thesisContentHash({
      market: market.instrumentSymbol,
      side: decision.side,
      probabilityYes: decision.probabilityYes,
      ...content,
    }),
    authorId: author.id,
    userId: null,
    marketId: market.id,
    side: decision.side,
    probabilityYes: decision.probabilityYes.toFixed(4),
    ...content,
    limitPrice: decision.limitPrice,
    quantity: plan.quantity,
    stakeUsd: String(AGENT_RULES.stakeUsd),
  });
  return { ok: true, thesisId: id };
}

/**
 * The `news` strategy once a model has answered: decide in code from its probability, and
 * when there is a trade, hand the thesis to the pipeline. Returns the run to log, with the
 * signal it carries. News and every arena model act on an answer through this one function.
 */
export async function actOnEstimate(
  db: Db,
  author: AuthorRow,
  market: MarketRecord,
  estimate: NewsEstimate,
  quote: { yesBid: string | null; yesAsk: string | null },
): Promise<{ cycle: Pick<AgentCycle, 'decision' | 'reason'>; signal: Record<string, unknown> }> {
  const decision = decideNews(estimate, quote);
  const signal = {
    probabilityYes: estimate.probability_yes,
    confidence: estimate.confidence,
    sources: estimate.evidence.length,
    quote,
  };
  if (decision.decision === 'skip') return { cycle: { decision: 'skip', reason: decision.reason }, signal };
  const submitted = await submit(db, author, market, decision, {
    headline: estimate.headline,
    body: estimate.body,
    evidence: estimate.evidence,
  });
  if (!submitted.ok) return { cycle: { decision: 'skip', reason: submitted.reason }, signal };
  return {
    cycle: {
      decision: 'trade',
      reason: `Puts YES at ${Math.round(estimate.probability_yes * 100)}%, ${Math.round(decision.edge * 100)} points from the price. Thesis sent to the auditor.`,
    },
    signal: { ...signal, side: decision.side, limitPrice: decision.limitPrice, edge: decision.edge, thesisId: submitted.thesisId },
  };
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
