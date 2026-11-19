import { LlmError, worstCallCostUsd } from '@thesis/core';
import { llmCostSince, type Db } from '@thesis/db';
import type { Logger } from '../recorder';

/**
 * The hard daily dollar cap over every model call the worker makes. A call is sent only if the
 * day's recorded spend (UTC), plus the most every call still in flight could cost, plus the most
 * this call could cost, stays within the cap. All model calls run in the one worker process, so
 * reservations held in memory cover calls running in parallel.
 */

export interface SpendReservation {
  /**
   * The call is over, and its row in llm_calls, if it cost anything, has been written: frees what
   * was held for it. `costUsd` is what it cost (0 when unknown). Only the first settle counts.
   */
  settle(costUsd: number): void;
}

export interface SpendGuard {
  /** Holds the most a call on `model` could cost, or throws LlmError('budget'). */
  reserve(model: string): Promise<SpendReservation>;
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** Whole millionths of a dollar, the precision llm_calls keeps, so the sums here are exact. */
const micros = (usd: number) => Math.round(usd * 1_000_000);
const usd = (amount: number) => `$${(amount / 1_000_000).toFixed(2)}`;

export function createSpendGuard(o: { db: Db; dailyCapUsd: number; logger: Logger; now?: () => Date }): SpendGuard {
  const now = o.now ?? (() => new Date());
  const cap = micros(o.dailyCapUsd);
  /** The most the calls now in flight could cost. */
  let inFlight = 0;
  /** What every settled call cost, ever: shows which calls ended while the day's spend was read. */
  let settledTotal = 0;
  let refusalLoggedFor = '';

  return {
    async reserve(model) {
      const worst = micros(worstCallCostUsd(model));
      const day = startOfUtcDay(now());
      const settledBefore = settledTotal;
      const recorded = micros(await llmCostSince(o.db, day));
      // A call that ended during that read is no longer in flight and may be missing from it.
      const endedDuringRead = settledTotal - settledBefore;
      const total = recorded + endedDuringRead + inFlight + worst;
      // Written so that a sum that is not a number refuses the call.
      if (!(total <= cap)) {
        const dayKey = day.toISOString().slice(0, 10);
        if (refusalLoggedFor !== dayKey) {
          refusalLoggedFor = dayKey;
          o.logger.warn(
            `llm: the daily spend cap of ${usd(cap)} is reached (${usd(recorded)} recorded, ${usd(inFlight)} in flight); ` +
              'model calls are refused until midnight UTC',
          );
        }
        throw new LlmError(
          'budget',
          `The daily language-model spend cap of ${usd(cap)} is reached. It resets at midnight UTC.`,
        );
      }
      inFlight += worst;

      let open = true;
      return {
        settle(costUsd) {
          if (!open) return;
          open = false;
          inFlight -= worst;
          const cost = Number.isFinite(costUsd) && costUsd > 0 ? micros(costUsd) : 0;
          settledTotal += cost;
          if (cost > worst) {
            o.logger.warn(`llm: a ${model} call cost ${usd(cost)}, more than the ${usd(worst)} held for it`);
          }
        },
      };
    },
  };
}
