import { ARENA_PURPOSE_PREFIXES, LlmError, isArenaPurpose, worstCallCostUsd } from '@thesis/core';
import { llmCostSince, type Db, type PurposeScope } from '@thesis/db';
import type { Logger } from '../recorder';

/**
 * The hard daily dollar cap over every model call the worker makes. A call is sent only if the
 * day's recorded spend (UTC), plus the most every call still in flight could cost, plus the most
 * this call could cost, stays within the cap. All model calls run in the one worker process, so
 * reservations held in memory cover calls running in parallel.
 *
 * The arena's calls (its models' looks and the audits of their theses, ARENA_PURPOSE_PREFIXES)
 * are also held, the same way, to a smaller cap of their own, so the arena can never spend what
 * people's audits need. The day's cap still counts them.
 */

export interface SpendReservation {
  /**
   * The call is over, and its row in llm_calls, if it cost anything, has been written: frees what
   * was held for it. `costUsd` is what it cost (0 when unknown). Only the first settle counts.
   */
  settle(costUsd: number): void;
}

export interface SpendGuard {
  /**
   * Holds the most a call on `model` could cost, or throws LlmError('budget'). `purpose` is the
   * call's, as llm_calls records it: an arena call is held to the arena's cap as well.
   */
  reserve(model: string, purpose?: string): Promise<SpendReservation>;
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** Whole millionths of a dollar, the precision llm_calls keeps, so the sums here are exact. */
const micros = (usd: number) => Math.round(usd * 1_000_000);
const usd = (amount: number) => `$${(amount / 1_000_000).toFixed(2)}`;

/** One cap and the calls it holds, all in millionths of a dollar. */
interface Cap {
  limit: number;
  /** The calls in llm_calls it counts. */
  scope: PurposeScope;
  /** What a refusal says, and what the log line calls the refused calls. */
  refusal: (limit: string) => string;
  calls: string;
  /** The most the calls now in flight under it could cost. */
  inFlight: number;
  /** What every call it held cost, ever: shows which calls ended while the day's spend was read. */
  settledTotal: number;
  refusalLoggedFor: string;
}

const cap = (limitUsd: number, fields: Pick<Cap, 'scope' | 'refusal' | 'calls'>): Cap => ({
  limit: micros(limitUsd),
  ...fields,
  inFlight: 0,
  settledTotal: 0,
  refusalLoggedFor: '',
});

export function createSpendGuard(o: {
  db: Db;
  dailyCapUsd: number;
  /** The arena's share of the day's cap (ARENA_DAILY_USD_CAP). Omitted, arena calls have only the day's cap. */
  arenaDailyCapUsd?: number;
  logger: Logger;
  now?: () => Date;
}): SpendGuard {
  const now = o.now ?? (() => new Date());
  const day = cap(o.dailyCapUsd, {
    scope: {},
    refusal: (limit) => `The daily language-model spend cap of ${limit} is reached. It resets at midnight UTC.`,
    calls: 'model calls',
  });
  const arena =
    o.arenaDailyCapUsd === undefined
      ? null
      : cap(o.arenaDailyCapUsd, {
          scope: { purposePrefix: ARENA_PURPOSE_PREFIXES },
          refusal: (limit) => `The arena's daily model spend cap of ${limit} is reached. It resets at midnight UTC.`,
          calls: 'arena calls',
        });

  return {
    async reserve(model, purpose = '') {
      const worst = micros(worstCallCostUsd(model));
      const since = startOfUtcDay(now());
      const caps = arena && isArenaPurpose(purpose) ? [day, arena] : [day];
      const settledBefore = caps.map((c) => c.settledTotal);
      const recorded = (await Promise.all(caps.map((c) => llmCostSince(o.db, since, c.scope)))).map(micros);

      // Every cap is checked before any is held, with nothing awaited in between.
      caps.forEach((c, i) => {
        // A call that ended during that read is no longer in flight and may be missing from it.
        const endedDuringRead = c.settledTotal - settledBefore[i]!;
        const total = recorded[i]! + endedDuringRead + c.inFlight + worst;
        // Written so that a sum that is not a number refuses the call.
        if (!(total <= c.limit)) {
          const dayKey = since.toISOString().slice(0, 10);
          if (c.refusalLoggedFor !== dayKey) {
            c.refusalLoggedFor = dayKey;
            o.logger.warn(
              `llm: ${c === arena ? "the arena's" : 'the'} daily spend cap of ${usd(c.limit)} is reached ` +
                `(${usd(recorded[i]!)} recorded, ${usd(c.inFlight)} in flight); ${c.calls} are refused until midnight UTC`,
            );
          }
          throw new LlmError('budget', c.refusal(usd(c.limit)));
        }
      });
      for (const c of caps) c.inFlight += worst;

      let open = true;
      return {
        settle(costUsd) {
          if (!open) return;
          open = false;
          const cost = Number.isFinite(costUsd) && costUsd > 0 ? micros(costUsd) : 0;
          for (const c of caps) {
            c.inFlight -= worst;
            c.settledTotal += cost;
          }
          if (cost > worst) {
            o.logger.warn(`llm: a ${model} call cost ${usd(cost)}, more than the ${usd(worst)} held for it`);
          }
        },
      };
    },
  };
}
