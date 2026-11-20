import {
  AGENT_RULES,
  ARENA_ROSTER,
  ARENA_STRATEGY,
  LlmError,
  NewsEstimateSchema,
  checkAgentAccount,
  checkAgentMarket,
  fromUnits,
  sideAsk,
  windowOpensAt,
  type ArenaEntrant,
  type Llm,
  type ModelId,
  type NewsEstimate,
  type RuleResult,
} from '@thesis/core';
import {
  agentRuns,
  agentState,
  and,
  countAuditingTheses,
  desc,
  ensureAgentAuthor,
  eq,
  or,
  sql,
  type AuthorRow,
  type Db,
  type MarketRecord,
} from '@thesis/db';
import {
  HOUR,
  NEWS_SYSTEM,
  actOnEstimate,
  errorText,
  isHalted,
  lastLooks,
  logRun,
  marketsWithThesis,
  newsQuestion,
  openMarkets,
  type AgentCycle,
} from './agent-kit';
import type { Logger } from './recorder';
import { agentLedger } from './thesis-pipeline';

/**
 * The model arena: one trading agent per AI model, every one on the News strategy. In a
 * cycle every model is shown the same market with the identical prompt, all at once, and
 * each decides on its own: it is its own author, with its own halt state, its own thesis
 * waiting on the auditor and its own positions. A model only estimates; side, size and
 * price are decided in code (`decideNews`), and a trade goes through the thesis pipeline
 * like any other agent's. Each model's runs are logged under its own agent key.
 */

export interface ArenaContender {
  entrant: ArenaEntrant;
  llm: Llm;
}

export interface ArenaDeps {
  db: Db;
  contenders: ArenaContender[];
  tradingEnabled: () => boolean;
  logger: Logger;
  now?: () => Date;
}

export interface ArenaResult {
  id: ModelId;
  decision: 'trade' | 'skip';
  reason: string;
}

export interface ArenaCycle {
  market: string | null;
  results: ArenaResult[];
}

/** Failed model calls in a row, with no answer between them, that halt a model until midnight UTC. */
const ARENA_ERROR_HALT = 5;
const HALT_REASON = 'consecutive model errors';

export async function runArenaCycle(deps: ArenaDeps): Promise<ArenaCycle> {
  const { db, contenders } = deps;
  if (contenders.length === 0) return { market: null, results: [] };
  const now = (deps.now ?? (() => new Date()))();
  const authors = await Promise.all(
    contenders.map(({ entrant }) =>
      ensureAgentAuthor(db, { agentKey: entrant.agentKey, displayName: entrant.displayName, strategySummary: ARENA_STRATEGY }),
    ),
  );

  const everyoneSkips = async (reason: string): Promise<ArenaCycle> => ({
    market: null,
    results: await Promise.all(
      contenders.map(async ({ entrant }) => {
        await logRun(db, entrant.agentKey, null, { decision: 'skip', reason });
        return { id: entrant.id, decision: 'skip' as const, reason };
      }),
    ),
  });
  if (!deps.tradingEnabled()) return everyoneSkips('Trading is switched off.');
  const market = await chooseMarket(db, now);
  if (!market) return everyoneSkips('No market is open for a look.');

  // One prompt, written once, for every model.
  const user = newsQuestion(market, now);
  const settled = await Promise.allSettled(
    contenders.map((contender, i) => look(deps, now, market, user, contender, authors[i]!)),
  );
  const results = settled.map((outcome, i): ArenaResult => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const { id } = contenders[i]!.entrant;
    deps.logger.error(`arena: ${id} on ${market.instrumentSymbol} failed: ${errorText(outcome.reason)}`);
    return { id, decision: 'skip', reason: 'The cycle failed for this model.' };
  });
  return { market: market.instrumentSymbol, results };
}

/**
 * Among markets the News rules allow (not a short window, at least an hour to run, a
 * two-sided book) and every fill rule could accept, the one no arena model has looked at for
 * longest.
 */
async function chooseMarket(db: Db, now: Date): Promise<MarketRecord | undefined> {
  const [open, ...looks] = await Promise.all([
    openMarkets(db, now, HOUR),
    ...ARENA_ROSTER.map((entrant) => lastLooks(db, entrant.agentKey)),
  ]);
  const lastLook = (marketId: string) => Math.max(0, ...looks.map((seen) => seen.get(marketId) ?? 0));
  return open
    .filter((m) => windowOpensAt(m.eventTicker, m.expiryAt) === null)
    .filter((m) => fillable(m, now))
    .sort((a, b) => lastLook(a.id) - lastLook(b.id))[0];
}

/**
 * Whether the fill's market rules (price band, spread, time to expiry) could accept a trade here
 * on either side, at the price now: the model picks the side, so both must pass. A one-sided
 * book cannot.
 */
function fillable(market: MarketRecord, now: Date): boolean {
  if (market.yesBid === null || market.yesAsk === null) return false;
  const spread = Number(market.yesAsk) - Number(market.yesBid);
  const minutesToExpiry = market.expiryAt ? (market.expiryAt.getTime() - now.getTime()) / 60_000 : null;
  return (['yes', 'no'] as const).every(
    (side) => checkAgentMarket({ price: Number(sideAsk(side, market)), spread, minutesToExpiry }).ok,
  );
}

/**
 * Whether the author's account could take a stake of AGENT_RULES.stakeUsd under the fill's
 * account rules, read from what the fill reads: the paper ledger and today's agent state.
 */
async function accountAllows(db: Db, author: AuthorRow, now: Date): Promise<RuleResult> {
  const [ledger, [state]] = await Promise.all([
    agentLedger(db, author.id),
    db
      .select()
      .from(agentState)
      .where(and(eq(agentState.agentKey, author.agentKey!), eq(agentState.day, now.toISOString().slice(0, 10)))),
  ]);
  return checkAgentAccount({
    halted: state?.halted ?? false,
    haltReason: state?.haltReason ?? null,
    realizedPnlTodayUsd: Number(state?.realizedPnlUsd ?? 0),
    openExposureUsd: Number(fromUnits(ledger.exposure)),
    tradesToday: state?.tradeCount ?? 0,
    // Checked by the look first, against the theses the model has waiting or live there.
    hasPositionOnMarket: false,
    balanceUsd: Number(fromUnits(ledger.balance)),
    costUsd: AGENT_RULES.stakeUsd,
  });
}

/**
 * One model's turn at the cycle's market. Every path logs one run under its agent key; only
 * a failure to write that run itself falls back to the worker log (in `runArenaCycle`).
 */
async function look(
  deps: ArenaDeps,
  now: Date,
  market: MarketRecord,
  user: string,
  { entrant, llm }: ArenaContender,
  author: AuthorRow,
): Promise<ArenaResult> {
  const { db, logger } = deps;
  const key = entrant.agentKey;
  const done = async (
    on: MarketRecord | null,
    cycle: Pick<AgentCycle, 'decision' | 'reason'>,
    signal?: Record<string, unknown>,
    error?: string,
  ): Promise<ArenaResult> => {
    await logRun(db, key, on, cycle, signal, error);
    return { id: entrant.id, ...cycle };
  };

  const halted = await isHalted(db, key, now);
  if (halted) return done(null, { decision: 'skip', reason: `Halted: ${halted}.` });
  if ((await countAuditingTheses(db, author.id)) > 0) {
    return done(null, { decision: 'skip', reason: 'An earlier thesis is still with the auditor.' });
  }
  if ((await marketsWithThesis(db, author.id)).has(market.id)) {
    return done(market, { decision: 'skip', reason: 'Already holds a position on this market.' });
  }
  // A look whose trade the fill would refuse is not paid for: no model call, no audit, no
  // registration. Like a halt, it is about the account, not this market, and is no model error.
  const allowed = await accountAllows(db, author, now);
  if (!allowed.ok) return done(null, { decision: 'skip', reason: allowed.message });

  const quote = { yesBid: market.yesBid, yesAsk: market.yesAsk };
  const served: Record<string, unknown> = {};
  let estimate: NewsEstimate;
  try {
    estimate = await llm.generateJson({
      purpose: `arena:${entrant.id}`,
      system: NEWS_SYSTEM,
      user,
      schema: NewsEstimateSchema,
      useSearch: true,
      // Sources a model never read are not a basis for a trade.
      requireSearch: true,
      onCompletion: (completion) => {
        served.model = completion.model;
        // Google's terms require its search suggestions to be shown with a grounded answer.
        if (completion.searchSuggestionsHtml) served.searchSuggestionsHtml = completion.searchSuggestionsHtml;
      },
    });
  } catch (error) {
    if (error instanceof LlmError && error.code === 'budget') {
      // Not the model's fault and not an error: no call was made.
      return done(
        market,
        { decision: 'skip', reason: 'Its daily model budget is spent, so it did not look. It resets at midnight UTC.' },
        { quote, refusal: error.message },
      );
    }
    logger.warn(`arena: ${entrant.id} on ${market.instrumentSymbol} failed: ${errorText(error)}`);
    const halt = 1 + (await failuresInARow(db, key, ARENA_ERROR_HALT - 1)) >= ARENA_ERROR_HALT;
    const result = await done(
      market,
      {
        decision: 'skip',
        reason: halt
          ? `The model call failed, ${ARENA_ERROR_HALT} times in a row. Halted until midnight UTC.`
          : error instanceof LlmError && error.code === 'ungrounded'
            ? 'It answered without searching the web, so it did not trade.'
            : 'The model call failed.',
      },
      { quote },
      errorText(error),
    );
    if (halt) {
      await haltForToday(db, key, now);
      logger.warn(`arena: ${entrant.id} halted until midnight UTC after ${ARENA_ERROR_HALT} failed model calls in a row`);
    }
    return result;
  }

  let acted: Awaited<ReturnType<typeof actOnEstimate>>;
  try {
    acted = await actOnEstimate(db, author, market, estimate, quote);
  } catch (error) {
    // The model answered and was paid for; what failed is ours. The run keeps the model's
    // probability, so it counts as an answer and never toward the model-error halt.
    logger.warn(`arena: ${entrant.id} on ${market.instrumentSymbol} answered, but acting on it failed: ${errorText(error)}`);
    return done(
      market,
      { decision: 'skip', reason: 'The trade could not be submitted.' },
      { probabilityYes: estimate.probability_yes, quote, ...served },
      errorText(error),
    );
  }
  return done(market, acted.cycle, { ...acted.signal, ...served });
}

/**
 * How many of the agent's latest model calls, newest first, failed before the last one that
 * answered (at most `limit`). A call that answered logs the model's probability, even when
 * acting on it then failed; a call that failed logs only an error. Runs without a call, such
 * as a budget refusal, count neither way.
 */
async function failuresInARow(db: Db, agentKey: string, limit: number): Promise<number> {
  const answeredSql = sql<boolean>`${agentRuns.signal} ->> 'probabilityYes' is not null`;
  const calls = await db
    .select({ answered: answeredSql })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentKey, agentKey), or(sql`${agentRuns.error} is not null`, answeredSql)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  const lastAnswer = calls.findIndex((call) => call.answered);
  return lastAnswer === -1 ? calls.length : lastAnswer;
}

/** Halts one agent for the current UTC day, the day `isHalted` reads. */
async function haltForToday(db: Db, agentKey: string, now: Date): Promise<void> {
  await db
    .insert(agentState)
    .values({ agentKey, day: now.toISOString().slice(0, 10), halted: true, haltReason: HALT_REASON })
    .onConflictDoUpdate({
      target: [agentState.agentKey, agentState.day],
      set: { halted: true, haltReason: HALT_REASON },
    });
}
