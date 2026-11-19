import { randomUUID } from 'node:crypto';
import {
  AGENT_RULES,
  FadeFindingSchema,
  NewsEstimateSchema,
  dataBlock,
  decideFade,
  decideNews,
  findMove,
  planOrder,
  sideAsk,
  thesisContentHash,
  thesisOnchainId,
  windowOpensAt,
  yesMidpoint,
  type AgentDecision,
  type Llm,
  type PricePoint,
} from '@thesis/core';
import {
  agentRuns,
  agentState,
  and,
  asc,
  countAuditingTheses,
  createAuditingThesis,
  ensureAgentAuthor,
  eq,
  gte,
  inArray,
  markets,
  pricePoints,
  sql,
  theses,
  type AuthorRow,
  type Db,
  type Evidence,
  type MarketRecord,
} from '@thesis/db';
import type { Logger } from './recorder';

/**
 * Worker job 2, the two agents that read: `news` and `fade`. By default only `news` runs,
 * once an hour, on the cheaper agent model: see ENABLED_AGENTS, NEWS_INTERVAL_MINUTES and
 * LLM_AGENT_MODEL. Each look reads several web pages, which is what a model call costs.
 *
 * Each cycle looks at one market, asks the model one question with web search, and decides
 * in code whether there is a trade. A trade is submitted exactly as a person's thesis is:
 * stored as `auditing` with the agent's intended position, then audited, filled under the
 * agent's limits and published by the thesis pipeline. Every cycle writes an `agent_runs`
 * row, including the ones that do nothing, with the reason.
 */

export interface AgentJobDeps {
  db: Db;
  llm: Llm;
  tradingEnabled: () => boolean;
  logger: Logger;
  now?: () => Date;
}

export interface AgentCycle {
  market: string | null;
  decision: 'trade' | 'skip';
  reason: string;
}

const GEMINI_EVENT_URL = 'https://www.gemini.com/predictions/';
const HOUR = 3_600_000;

const NEWS = {
  agentKey: 'news',
  displayName: 'News Desk',
  strategySummary:
    'Reads current reporting on a market, estimates the probability of YES, and trades when its estimate is 10 points or more away from the price, it is not unsure, and it can cite at least two sources.',
};
const FADE = {
  agentKey: 'fade',
  displayName: 'Fade',
  strategySummary:
    'Looks for a move of 10 points or more in 30 minutes, searches for news that explains it, and when it finds none bets on half of the move reversing.',
};

const NEWS_SYSTEM = `You estimate the probability that a prediction market contract resolves YES, for an agent that publishes its reasoning.

Search the web for current, reliable reporting and data on the question. Then return:
- probability_yes: your probability that the contract resolves YES, from the evidence. Do not anchor on the market price you are shown.
- confidence: "low" if the evidence is thin, stale or conflicting; otherwise "medium" or "high".
- headline: one line, at most 90 characters, stating your view.
- body: at most 1,200 characters of plain prose arguing that view from what the sources say. State facts you can source. Do not give trading advice, a position size or a price target.
- evidence: two to six sources you actually read, each with a one-sentence statement of what it shows and its web address.
- no_trade_reason: a sentence if the question is ambiguous, cannot be researched, or you would not stand behind a number; otherwise null.

You only estimate and explain. Whether to trade, which side, how much and at what price are decided elsewhere.`;

const FADE_SYSTEM = `A prediction market's price moved sharply in the last 30 minutes. Find out whether anything published in the last hour explains the move.

Search the web for news, data releases, official statements or events about the market's subject from the last hour or two. Return:
- explained: true if you found something published recently that plausibly accounts for a move in this direction; false if you looked and found nothing.
- explanation: one or two sentences on what you found, or null.
- sources: up to four sources you read, each with a one-sentence statement and its web address. Include sources that show the absence of news, such as a live news page with nothing new.

Report what you found. Do not predict where the price goes next.`;

const cents = (price: number) => `${Math.round(Math.round(price * 10_000) / 100)}¢`;

function describeMarket(market: MarketRecord, now: Date): string {
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

/** Tracked, open contracts with at least `minMsLeft` to run. */
async function openMarkets(db: Db, now: Date, minMsLeft: number): Promise<MarketRecord[]> {
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
async function marketsWithThesis(db: Db, authorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ marketId: theses.marketId })
    .from(theses)
    .where(and(eq(theses.authorId, authorId), inArray(theses.status, ['auditing', 'published', 'resolved'])));
  return new Set(rows.map((row) => row.marketId));
}

/** When the agent last looked at each market. */
async function lastLooks(db: Db, agentKey: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ marketId: agentRuns.marketId, at: sql<Date>`max(${agentRuns.createdAt})`.mapWith(agentRuns.createdAt) })
    .from(agentRuns)
    .where(eq(agentRuns.agentKey, agentKey))
    .groupBy(agentRuns.marketId);
  return new Map(rows.filter((r) => r.marketId !== null).map((r) => [r.marketId!, r.at.getTime()]));
}

async function isHalted(db: Db, agentKey: string, now: Date): Promise<string | null> {
  const [state] = await db
    .select()
    .from(agentState)
    .where(and(eq(agentState.agentKey, agentKey), eq(agentState.day, now.toISOString().slice(0, 10))));
  return state?.halted ? (state.haltReason ?? 'stopped') : null;
}

async function logRun(
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
async function submit(
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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One `news` cycle: the eligible market it has gone longest without looking at.
 * Eligible means a non-short contract with at least an hour to run, a two-sided book,
 * no thesis from this agent yet, and not looked at in the last six hours.
 */
export async function runNewsCycle(deps: AgentJobDeps): Promise<AgentCycle> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const author = await ensureAgentAuthor(db, NEWS);
  if (!deps.tradingEnabled()) return logRun(db, NEWS.agentKey, null, { decision: 'skip', reason: 'Trading is switched off.' });
  const halted = await isHalted(db, NEWS.agentKey, now);
  if (halted) return logRun(db, NEWS.agentKey, null, { decision: 'skip', reason: `Halted: ${halted}.` });
  if ((await countAuditingTheses(db, author.id)) > 0) {
    return logRun(db, NEWS.agentKey, null, { decision: 'skip', reason: 'An earlier thesis is still with the auditor.' });
  }

  const [taken, looks, open] = await Promise.all([
    marketsWithThesis(db, author.id),
    lastLooks(db, NEWS.agentKey),
    openMarkets(db, now, HOUR),
  ]);
  const candidates = open
    .filter((m) => windowOpensAt(m.eventTicker, m.expiryAt) === null)
    .filter((m) => m.yesBid !== null && m.yesAsk !== null && !taken.has(m.id))
    .filter((m) => now.getTime() - (looks.get(m.id) ?? 0) >= 6 * HOUR)
    .sort((a, b) => (looks.get(a.id) ?? 0) - (looks.get(b.id) ?? 0));
  const market = candidates[0];
  if (!market) return logRun(db, NEWS.agentKey, null, { decision: 'skip', reason: 'No market is due for a look.' });

  const quote = { yesBid: market.yesBid, yesAsk: market.yesAsk };
  try {
    const estimate = await deps.llm.generateJson({
      purpose: 'news',
      system: NEWS_SYSTEM,
      user: `${describeMarket(market, now)}\n\nFor reference only, YES currently costs ${cents(Number(market.yesAsk))} to buy.`,
      schema: NewsEstimateSchema,
      useSearch: true,
    });
    const decision = decideNews(estimate, quote);
    const signal = {
      probabilityYes: estimate.probability_yes,
      confidence: estimate.confidence,
      sources: estimate.evidence.length,
      quote,
    };
    if (decision.decision === 'skip') {
      return logRun(db, NEWS.agentKey, market, { decision: 'skip', reason: decision.reason }, signal);
    }
    const submitted = await submit(db, author, market, decision, {
      headline: estimate.headline,
      body: estimate.body,
      evidence: estimate.evidence,
    });
    if (!submitted.ok) return logRun(db, NEWS.agentKey, market, { decision: 'skip', reason: submitted.reason }, signal);
    return logRun(
      db,
      NEWS.agentKey,
      market,
      {
        decision: 'trade',
        reason: `Puts YES at ${Math.round(estimate.probability_yes * 100)}%, ${Math.round(decision.edge * 100)} points from the price. Thesis sent to the auditor.`,
      },
      { ...signal, side: decision.side, limitPrice: decision.limitPrice, edge: decision.edge, thesisId: submitted.thesisId },
    );
  } catch (error) {
    deps.logger.warn(`news: ${market.instrumentSymbol} failed: ${errorText(error)}`);
    return logRun(db, NEWS.agentKey, market, { decision: 'skip', reason: 'The model call failed.' }, { quote }, errorText(error));
  }
}

/** The recorded YES midpoints of a market since `since`, oldest first. */
async function midpoints(db: Db, marketId: string, since: Date): Promise<PricePoint[]> {
  const rows = await db
    .select({ ts: pricePoints.ts, yesBid: pricePoints.yesBid, yesAsk: pricePoints.yesAsk })
    .from(pricePoints)
    .where(and(eq(pricePoints.marketId, marketId), gte(pricePoints.ts, since)))
    .orderBy(asc(pricePoints.ts));
  const points: PricePoint[] = [];
  for (const row of rows) {
    const mid = yesMidpoint({ bid: row.yesBid, ask: row.yesAsk });
    if (mid !== null) points.push({ t: row.ts.getTime(), price: mid });
  }
  return points;
}

/**
 * One `fade` cycle: the first market with more than two hours to run that moved 10 points
 * or more in the last 30 minutes, has no thesis from this agent, and was not looked at in
 * the last hour.
 */
export async function runFadeCycle(deps: AgentJobDeps): Promise<AgentCycle> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const author = await ensureAgentAuthor(db, FADE);
  if (!deps.tradingEnabled()) return logRun(db, FADE.agentKey, null, { decision: 'skip', reason: 'Trading is switched off.' });
  const halted = await isHalted(db, FADE.agentKey, now);
  if (halted) return logRun(db, FADE.agentKey, null, { decision: 'skip', reason: `Halted: ${halted}.` });
  if ((await countAuditingTheses(db, author.id)) > 0) {
    return logRun(db, FADE.agentKey, null, { decision: 'skip', reason: 'An earlier thesis is still with the auditor.' });
  }

  const [taken, looks, open] = await Promise.all([
    marketsWithThesis(db, author.id),
    lastLooks(db, FADE.agentKey),
    openMarkets(db, now, 2 * HOUR),
  ]);
  for (const market of open) {
    if (taken.has(market.id) || now.getTime() - (looks.get(market.id) ?? 0) < HOUR) continue;
    const move = findMove(await midpoints(db, market.id, new Date(now.getTime() - 35 * 60_000)), now.getTime());
    if (!move) continue;

    const quote = { yesBid: market.yesBid, yesAsk: market.yesAsk };
    const direction = move.change > 0 ? 'rose' : 'fell';
    const moved = `YES ${direction} from ${cents(move.from)} to ${cents(move.to)} between ${new Date(move.fromT).toISOString().slice(11, 16)} and ${new Date(move.toT).toISOString().slice(11, 16)} UTC`;
    try {
      const finding = await deps.llm.generateJson({
        purpose: 'fade',
        system: FADE_SYSTEM,
        user: `${describeMarket(market, now)}\n\n${moved}.`,
        schema: FadeFindingSchema,
        useSearch: true,
      });
      const decision = decideFade(move, finding, quote);
      const signal = { move, explained: finding.explained, quote };
      if (decision.decision === 'skip') {
        return logRun(db, FADE.agentKey, market, { decision: 'skip', reason: decision.reason }, signal);
      }
      const points = Math.round(Math.abs(move.change) * 100);
      const submitted = await submit(db, author, market, decision, {
        headline: `Fading a ${points}-point ${move.change > 0 ? 'rise' : 'drop'} with no news behind it`,
        body:
          `${moved}, a move of ${points} points in under half an hour. A search for news, data or statements ` +
          `published in the last hour found nothing that explains it. Moves like this with no cause often give ` +
          `some of it back, so this thesis bets on half of it reversing, which puts YES at ` +
          `${Math.round(decision.probabilityYes * 100)}%. It is wrong if the move was information the search missed.`,
        evidence: [
          { claim: 'The market’s page, with its price history', url: `${GEMINI_EVENT_URL}${market.eventTicker}` },
          ...finding.sources,
        ].slice(0, 6),
      });
      if (!submitted.ok) return logRun(db, FADE.agentKey, market, { decision: 'skip', reason: submitted.reason }, signal);
      return logRun(
        db,
        FADE.agentKey,
        market,
        { decision: 'trade', reason: `${moved}; no explanation found. Thesis sent to the auditor.` },
        { ...signal, side: decision.side, limitPrice: decision.limitPrice, edge: decision.edge, thesisId: submitted.thesisId },
      );
    } catch (error) {
      deps.logger.warn(`fade: ${market.instrumentSymbol} failed: ${errorText(error)}`);
      return logRun(db, FADE.agentKey, market, { decision: 'skip', reason: 'The model call failed.' }, { move, quote }, errorText(error));
    }
  }
  return logRun(db, FADE.agentKey, null, { decision: 'skip', reason: 'No market moved 10 points in the last 30 minutes.' });
}
