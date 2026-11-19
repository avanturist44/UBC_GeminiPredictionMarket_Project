import {
  LlmError,
  WORST_CALL,
  callCostUsd,
  createLlm,
  worstCallCostUsd,
  type GenerateJsonArgs,
  type Llm,
  type LlmProvider,
  type LlmUsage,
} from '@thesis/core';
import { llmTokensSince, recordLlmCall, type Db } from '@thesis/db';
import type { Logger } from '../recorder';
import { createAnthropicProvider } from './anthropic';
import type { SpendGuard } from './spend-guard';

/**
 * The worker's language model: the provider named in the environment, with every call priced
 * and counted in the database, refused once the day's token cap is reached, and refused by the
 * shared dollar guard (spend-guard.ts) when it could take the day's spend past the dollar cap.
 */

export interface LlmSettings {
  provider: 'anthropic' | 'none';
  model: string;
  apiKey?: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Input plus output tokens allowed per UTC day, across the auditor and the agents. */
  dailyTokenCap: number;
  /** Purposes starting with this do not count toward the cap (see withSpendCap). */
  excludePrefix?: string;
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Wraps a provider with the spend caps and the usage log. Tests pass their own provider. */
export function withSpendCap(
  db: Db,
  provider: LlmProvider,
  options: {
    dailyTokenCap: number;
    logger: Logger;
    /** Count only calls whose purpose starts with this (one arena model's own cap). */
    purposePrefix?: string;
    /** Do not count calls whose purpose starts with this (keeps arena spend off the auditor's cap). */
    excludePrefix?: string;
    /** The daily dollar cap: the one guard the worker shares between every Llm it builds. */
    guard: SpendGuard;
    now?: () => Date;
  },
): Llm {
  // Checked at run time too, so a model client cannot be built uncapped whatever the types say.
  if (!options.guard) throw new Error('withSpendCap needs the spend guard (createSpendGuard).');
  const { guard } = options;
  const now = options.now ?? (() => new Date());

  async function beforeCall(): Promise<void> {
    const used = await llmTokensSince(db, startOfUtcDay(now()), {
      purposePrefix: options.purposePrefix,
      excludePrefix: options.excludePrefix,
    });
    if (used >= options.dailyTokenCap) {
      throw new LlmError(
        'budget',
        `The daily language-model cap of ${options.dailyTokenCap} tokens is reached. It resets at midnight UTC.`,
      );
    }
  }

  /** Prices a call and writes its row. Returns the price, even if the row could not be written. */
  async function record(purpose: string, model: string, usage: LlmUsage, searches: number): Promise<number> {
    const priced = callCostUsd(model, usage, searches);
    const costUsd = Number.isFinite(priced) ? priced : worstCallCostUsd(model);
    try {
      await recordLlmCall(db, { purpose, model, ...usage, costUsd: costUsd.toFixed(6) });
    } catch (error) {
      // Losing a usage row must not lose the answer that was already paid for.
      options.logger.error(`llm: could not record usage: ${error instanceof Error ? error.message : String(error)}`);
    }
    return costUsd;
  }

  /**
   * The provider as one generateJson call sees it. Each model call, the retry included, holds
   * its worst case with the guard while it runs, and frees it once its row is written, on every
   * path. The hold lasts until the provider itself answers, even after the wrapper has stopped
   * waiting for it, so a call that is still running is never left uncounted.
   */
  const metered = (purpose: string): LlmProvider => ({
    model: provider.model,
    async complete(request) {
      const reservation = await guard.reserve(provider.model);
      // A provider that does not say how many searches it ran is counted at the most.
      const unsaidSearches = request.useSearch ? WORST_CALL.searches : 0;
      let costUsd = 0;
      try {
        const completion = await provider.complete(request);
        costUsd = await record(purpose, completion.model, completion.usage, completion.searches ?? unsaidSearches);
        return completion;
      } catch (error) {
        // A refusal or a cut-off reply was still paid for.
        if (error instanceof LlmError && error.usage) {
          costUsd = await record(purpose, provider.model, error.usage, unsaidSearches);
        }
        throw error;
      } finally {
        reservation.settle(costUsd);
      }
    },
  });

  return {
    model: provider.model,
    generateJson: <T>(args: GenerateJsonArgs<T>) =>
      createLlm({ provider: metered(args.purpose), beforeCall }).generateJson(args),
  };
}

/** Null when no model is configured: the auditor then runs its phrase screen only. */
export function createWorkerLlm(db: Db, settings: LlmSettings, logger: Logger, guard: SpendGuard): Llm | null {
  if (settings.provider === 'none') return null;
  const provider = createAnthropicProvider({
    model: settings.model,
    apiKey: settings.apiKey,
    effort: settings.effort,
  });
  return withSpendCap(db, provider, {
    dailyTokenCap: settings.dailyTokenCap,
    excludePrefix: settings.excludePrefix,
    guard,
    logger,
  });
}
