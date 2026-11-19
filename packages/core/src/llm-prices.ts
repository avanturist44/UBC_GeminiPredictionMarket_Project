import type { LlmUsage } from './llm';

/**
 * What a model call costs, in US dollars, for the daily dollar cap (apps/worker/src/llm).
 *
 * Prices are per million tokens and per web search, rounded up where sources differ. Anthropic
 * and Google are from their own pages; the rest from pricing summaries checked 2026-11-19.
 */

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  perSearch: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20, perSearch: 0.01 },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, perSearch: 0.01 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10, perSearch: 0.01 },
  'grok-4.7': { inputPerMillion: 2, outputPerMillion: 6, perSearch: 0.005 },
  // The first 1,500 grounded prompts a day are free; the arena uses at most 24.
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10, perSearch: 0 },
  // DeepSeek does not bill its web tools. The token rate is its peak-hour one.
  'deepseek-flash': { inputPerMillion: 0.3, outputPerMillion: 1.2, perSearch: 0 },
};

/** For a model not listed: above every listed model, so an unknown id is never under-counted. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputPerMillion: 5, outputPerMillion: 25, perSearch: 0.01 };

/**
 * The most one call is assumed to use, and so what the cap holds back before sending it. The
 * adapters cap every reply at `outputTokens`, and Anthropic's search at `searches`.
 */
export const WORST_CALL = { inputTokens: 60_000, outputTokens: 16_000, searches: 5 } as const;

/**
 * The price of a model id as listed, or as a provider serves it with a version or date after it
 * (`gpt-5-2025-08-07` is `gpt-5`). The suffix must start with a digit, so a different model that
 * shares the start of a listed id (`gpt-5-pro`) is priced as unknown rather than under-priced.
 */
export function priceFor(model: string): ModelPrice {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const id of Object.keys(MODEL_PRICES)) {
    if (model.startsWith(id) && /^[-@]\d/.test(model.slice(id.length)) && id.length > (best?.length ?? 0)) best = id;
  }
  return best ? MODEL_PRICES[best]! : UNKNOWN_MODEL_PRICE;
}

export function callCostUsd(model: string, usage: LlmUsage, searches: number): number {
  const price = priceFor(model);
  return (
    (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000 +
    searches * price.perSearch
  );
}

export function worstCallCostUsd(model: string): number {
  return callCostUsd(model, WORST_CALL, WORST_CALL.searches);
}
