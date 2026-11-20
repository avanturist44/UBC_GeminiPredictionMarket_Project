import { ARENA_ROSTER, type ArenaEntrant, type ArenaProvider, type LlmProvider } from '@thesis/core';
import type { Db } from '@thesis/db';
import type { ArenaContender } from './arena';
import type { WorkerEnv } from './env';
import { withSpendCap } from './llm';
import { createAnthropicProvider } from './llm/anthropic';
import { createGoogleProvider } from './llm/google';
import { createResponsesProvider } from './llm/responses';
import type { SpendGuard } from './llm/spend-guard';
import type { Logger } from './recorder';

/**
 * The arena's models as the worker runs them: each roster entrant whose API key is set, with
 * its own daily token cap (purposes `arena:<id>`, never the auditor's budget) and the worker's
 * one daily dollar guard, shared with every other model call.
 */

/** Builds the provider adapter for one entrant, given that entrant's key. Tests pass their own. */
export type ProviderFactory = (entrant: ArenaEntrant, apiKey: string) => LlmProvider;

/** The environment variable that holds each provider's API key. Claude uses the auditor's key. */
export const ARENA_KEY_VARS = {
  anthropic: 'LLM_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
} as const satisfies Record<ArenaProvider, keyof WorkerEnv>;

/** The real adapters. `fetch` stands in for the network in tests. */
export function arenaProviders(fetch?: typeof globalThis.fetch): ProviderFactory {
  return ({ provider, model }, apiKey) => {
    switch (provider) {
      case 'anthropic':
        return createAnthropicProvider({ model, apiKey, fetch });
      case 'deepseek':
        // DeepSeek serves the Anthropic API, with its own hosted search tool.
        return createAnthropicProvider({
          model,
          apiKey,
          baseUrl: 'https://api.deepseek.com/anthropic',
          searchTool: { type: 'deepseek_web_search', name: 'deepseek_web_search' },
          fetch,
        });
      case 'openai':
        return createResponsesProvider({ vendor: provider, baseUrl: 'https://api.openai.com/v1', apiKey, model, fetch });
      case 'xai':
        return createResponsesProvider({ vendor: provider, baseUrl: 'https://api.x.ai/v1', apiKey, model, fetch });
      case 'google':
        return createGoogleProvider({ apiKey, model, fetch });
    }
  };
}

/**
 * One contender per roster entrant whose key is set, in roster order. The ones left out are
 * named, with the variable each needs, in one log line.
 */
export function createArenaContenders(
  env: WorkerEnv,
  db: Db,
  logger: Logger,
  guard: SpendGuard,
  make: ProviderFactory = arenaProviders(),
): ArenaContender[] {
  const contenders: ArenaContender[] = [];
  const missing: string[] = [];
  for (const entrant of ARENA_ROSTER) {
    const variable = ARENA_KEY_VARS[entrant.provider];
    const apiKey = env[variable];
    if (!apiKey) {
      missing.push(`${entrant.id} (${variable})`);
      continue;
    }
    const llm = withSpendCap(db, make(entrant, apiKey), {
      dailyTokenCap: env.ARENA_DAILY_TOKEN_CAP_PER_MODEL,
      purposePrefix: `arena:${entrant.id}`,
      guard,
      logger,
    });
    contenders.push({ entrant, llm });
  }
  if (missing.length > 0) logger.warn(`arena: left out, no API key set: ${missing.join(', ')}`);
  return contenders;
}

/**
 * Whether the model a provider served is the entrant's: its id, or its id with a version or date
 * after it (`gpt-5-2025-08-07`). The suffix must start with a digit, so another model that shares
 * the start of the id (`gpt-5-mini`) is a mismatch. The same rule prices a served model.
 */
export function checkServedModel(entrant: ArenaEntrant, served: string): { ok: true } | { ok: false; message: string } {
  const suffix = served.startsWith(entrant.model) ? served.slice(entrant.model.length) : null;
  if (suffix === '' || (suffix !== null && /^[-@]\d/.test(suffix))) return { ok: true };
  return {
    ok: false,
    message: `${entrant.displayName} is listed as ${entrant.model}, but the provider served ${served || 'no model name'}`,
  };
}
