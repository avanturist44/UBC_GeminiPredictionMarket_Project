import { LlmError, createLlm, type Llm, type LlmProvider } from '@thesis/core';
import { llmTokensSince, recordLlmCall, type Db } from '@thesis/db';
import type { Logger } from '../recorder';
import { createAnthropicProvider } from './anthropic';

/**
 * The worker's language model: the provider named in the environment, with every call
 * counted in the database and refused once the day's token cap is reached.
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

/** Wraps a provider with the spend cap and the usage log. Tests pass their own provider. */
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
    now?: () => Date;
  },
): Llm {
  const now = options.now ?? (() => new Date());
  return createLlm({
    provider,
    async beforeCall() {
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
    },
    async onUsage(purpose, completion) {
      try {
        await recordLlmCall(db, { purpose, model: completion.model, ...completion.usage });
      } catch (error) {
        // Losing a usage row must not lose the answer that was already paid for.
        options.logger.error(`llm: could not record usage: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

/** Null when no model is configured: the auditor then runs its phrase screen only. */
export function createWorkerLlm(db: Db, settings: LlmSettings, logger: Logger): Llm | null {
  if (settings.provider === 'none') return null;
  const provider = createAnthropicProvider({
    model: settings.model,
    apiKey: settings.apiKey,
    effort: settings.effort,
  });
  return withSpendCap(db, provider, {
    dailyTokenCap: settings.dailyTokenCap,
    excludePrefix: settings.excludePrefix,
    logger,
  });
}
