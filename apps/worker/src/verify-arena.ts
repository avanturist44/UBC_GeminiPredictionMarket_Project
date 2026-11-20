// Checks every arena model against its live API: pnpm --filter @thesis/worker verify:arena
// It makes one real, billed web-search call per model whose key is set (the arena's own prompt
// and reply shape, roughly 40,000 tokens each), all at once, and prints no secrets.
// Every call goes through the worker's own spend caps: the day's dollar cap (LLM_DAILY_USD_CAP)
// and that model's own daily token cap (ARENA_DAILY_TOKEN_CAP_PER_MODEL). It is recorded in
// llm_calls as `arena:<id>:verify`, so it counts against that model's budget, never the
// auditor's. That needs the database, so without DATABASE_URL, or with a database the day's
// spend cannot be read from, it refuses to call any model.
// It exits 1 when a configured model fails: no answer, a served model other than the roster's,
// no web search, or no llm_calls row. A model without its key is listed as not configured.
import { ARENA_ROSTER, NewsEstimateSchema, type ArenaEntrant, type LlmCompletion } from '@thesis/core';
import { createDb, eq, llmCalls, llmCostSince, sql, type Db, type MarketRecord } from '@thesis/db';
import { NEWS_SYSTEM, errorText, newsQuestion } from './agent-kit';
import type { ArenaContender } from './arena';
import { ARENA_KEY_VARS, checkServedModel, createArenaContenders } from './arena-contenders';
import { loadEnv, type WorkerEnv } from './env';
import { createSpendGuard } from './llm/spend-guard';
import type { Logger } from './recorder';

const verifyPurpose = (entrant: ArenaEntrant) => `arena:${entrant.id}:verify`;

/** What one model's verify call came to. */
interface Outcome {
  seconds: number;
  /** The completion whose reply validated, if one did. */
  completion?: LlmCompletion;
  sources?: number;
  probability?: number;
  error?: string;
}

/** Calls and dollars recorded in llm_calls under `purpose`, ever. */
async function recorded(db: Db, purpose: string): Promise<{ calls: number; costUsd: number }> {
  const [row] = await db
    .select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text` })
    .from(llmCalls)
    .where(eq(llmCalls.purpose, purpose));
  return { calls: row?.calls ?? 0, costUsd: Number(row?.cost ?? 0) };
}

/**
 * A market to ask about: made up, but put to every model exactly as the arena puts a real one.
 * Brent's price moves daily and is widely reported, so an answer needs a search.
 */
function sampleMarket(now: Date): MarketRecord {
  const expiry = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 22));
  // Gemini's event tickers carry the expiry as YYMMDDHHMM.
  const eventTicker = `BRENT${expiry.toISOString().replace(/\D/g, '').slice(2, 12)}`;
  const day = expiry.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return {
    id: '00000000-0000-0000-0000-000000000000',
    instrumentSymbol: `GEMI-${eventTicker}-HI70`,
    eventTicker,
    contractTicker: 'HI70',
    title: `Oil (Brent) price on ${day}?`,
    contractLabel: '$70 or above',
    category: 'Commodities',
    expiryAt: expiry,
    status: 'active',
    marketState: 'open',
    strike: '70',
    yesBid: '0.48',
    yesAsk: '0.52',
    lastPrice: '0.50',
    resolutionSide: null,
    resolvedAt: null,
    tracked: true,
    keywords: [],
    quantityIncrement: '0.01',
    quantityMinimum: '0.01',
    priceIncrement: '0.01',
    sourceDetails: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** One search call, the arena's own, under the verify purpose. Never throws. */
async function check({ entrant, llm }: ArenaContender, user: string): Promise<Outcome> {
  const started = Date.now();
  let completion: LlmCompletion | undefined;
  const seconds = () => (Date.now() - started) / 1000;
  try {
    const estimate = await llm.generateJson({
      purpose: verifyPurpose(entrant),
      system: NEWS_SYSTEM,
      user,
      schema: NewsEstimateSchema,
      useSearch: true,
      requireSearch: true,
      onCompletion: (c) => {
        completion = c;
      },
    });
    return { seconds: seconds(), completion, sources: estimate.evidence.length, probability: estimate.probability_yes };
  } catch (error) {
    const e = error as Error & { code?: string };
    return { seconds: seconds(), error: `${e.code ? `${e.code}: ` : ''}${errorText(error)}` };
  }
}

(async () => {
  let env: WorkerEnv;
  try {
    // The worker's own settings, from the repo-root .env as the worker reads them.
    env = loadEnv();
  } catch (error) {
    console.error(
      'verify:arena will not call any model: each call must be checked against the daily dollar cap and recorded, ' +
        `which needs the database. ${errorText(error)}`,
    );
    process.exit(1);
  }

  // Belt and braces: the adapters already keep keys out of their errors.
  const keys = Object.values(ARENA_KEY_VARS)
    .map((variable) => env[variable])
    .filter((key): key is string => Boolean(key));
  const say = (line: string) => console.log(keys.reduce((text, key) => text.split(key).join('[key]'), line));

  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const now = new Date();
    let spentToday: number;
    try {
      spentToday = await llmCostSince(db, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    } catch (error) {
      console.error(
        `verify:arena will not call any model: the day's model spend could not be read from the database (is it migrated?): ${errorText(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    say(`model spend today: $${spentToday.toFixed(2)} of the $${env.LLM_DAILY_USD_CAP} daily cap`);

    const logger: Logger = {
      info: (message) => say(`   ${message}`),
      warn: (message) => say(`   ${message}`),
      error: (message) => say(`   ${message}`),
    };
    // The worker's own wiring: each model with its key, its token cap and the dollar guard.
    const guard = createSpendGuard({ db, dailyCapUsd: env.LLM_DAILY_USD_CAP, logger });
    const contenders = createArenaContenders(env, db, logger, guard);
    if (contenders.length === 0) {
      say('no arena model has its API key set, so there is nothing to verify');
      process.exitCode = 1;
      return;
    }

    say(`asking ${contenders.length} of ${ARENA_ROSTER.length} models at once; a search call can take three minutes\n`);
    const user = newsQuestion(sampleMarket(now), now);
    const before = await Promise.all(contenders.map(({ entrant }) => recorded(db, verifyPurpose(entrant))));
    const outcomes = await Promise.all(contenders.map((contender) => check(contender, user)));
    const after = await Promise.all(contenders.map(({ entrant }) => recorded(db, verifyPurpose(entrant))));

    let failed = 0;
    let costUsd = 0;
    for (const entrant of ARENA_ROSTER) {
      const name = `${entrant.id} (${entrant.displayName}, ${entrant.model})`;
      const i = contenders.findIndex((c) => c.entrant.id === entrant.id);
      if (i === -1) {
        say(`${name}: not configured (${ARENA_KEY_VARS[entrant.provider]} is not set)`);
        continue;
      }
      const outcome = outcomes[i]!;
      const calls = after[i]!.calls - before[i]!.calls;
      const cost = after[i]!.costUsd - before[i]!.costUsd;
      costUsd += cost;
      const problems: string[] = [];
      const lines: string[] = [];

      if (outcome.error) {
        problems.push(outcome.error);
        lines.push(`error: ${outcome.error}`);
      } else {
        const served = outcome.completion?.model ?? '';
        const match = checkServedModel(entrant, served);
        if (!match.ok) problems.push(match.message);
        lines.push(`served model: ${served || 'not reported'} (${match.ok ? 'matches the roster' : `MISMATCH: ${match.message}`})`);

        const searches = outcome.completion?.searches;
        if (!searches) problems.push('no web search ran');
        lines.push(
          `web search: ${searches ? `yes, ${searches} counted` : searches === 0 ? 'NO, none ran' : 'NOT REPORTED'}`,
        );
        lines.push(`reply: probability ${outcome.probability}, ${outcome.sources} sources cited`);
      }
      // A model that answered but left no row would be spending outside the caps' sight.
      if (calls === 0 && !outcome.error) problems.push('the call was not recorded in llm_calls');
      lines.push(`cost recorded: $${cost.toFixed(4)} in ${calls} ${calls === 1 ? 'call' : 'calls'} (${verifyPurpose(entrant)})`);

      if (problems.length > 0) failed += 1;
      say(`${name}: ${problems.length === 0 ? 'ok' : 'FAILED'} in ${outcome.seconds.toFixed(1)}s`);
      for (const line of lines) say(`   ${line}`);
    }

    const missing = ARENA_ROSTER.length - contenders.length;
    say(
      `\n${contenders.length - failed} ok, ${failed} failed, ${missing} not configured; ` +
        `$${costUsd.toFixed(4)} recorded for these calls`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await close();
  }
})();
