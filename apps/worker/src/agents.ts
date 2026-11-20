import {
  FadeFindingSchema,
  NewsEstimateSchema,
  decideFade,
  decideNews,
  findMove,
  windowOpensAt,
  yesMidpoint,
  type Llm,
  type PricePoint,
} from '@thesis/core';
import { and, asc, countAuditingTheses, ensureAgentAuthor, eq, gte, pricePoints, type Db } from '@thesis/db';
import {
  GEMINI_EVENT_URL,
  HOUR,
  NEWS_SYSTEM,
  cents,
  describeMarket,
  errorText,
  isHalted,
  lastLooks,
  logRun,
  marketsWithThesis,
  newsQuestion,
  openMarkets,
  submit,
  type AgentCycle,
} from './agent-kit';
import type { Logger } from './recorder';

export type { AgentCycle } from './agent-kit';

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

const FADE_SYSTEM = `A prediction market's price moved sharply in the last 30 minutes. Find out whether anything published in the last hour explains the move.

Search the web for news, data releases, official statements or events about the market's subject from the last hour or two. Return:
- explained: true if you found something published recently that plausibly accounts for a move in this direction; false if you looked and found nothing.
- explanation: one or two sentences on what you found, or null.
- sources: up to four sources you read, each with a one-sentence statement and its web address. Include sources that show the absence of news, such as a live news page with nothing new.

Report what you found. Do not predict where the price goes next.`;

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
      user: newsQuestion(market, now),
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
