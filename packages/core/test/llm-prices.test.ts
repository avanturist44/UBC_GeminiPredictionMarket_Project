import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, UNKNOWN_MODEL_PRICE, WORST_CALL, callCostUsd, priceFor, worstCallCostUsd } from '../src/index';

describe('model prices', () => {
  it('prices a call from its tokens and searches', () => {
    expect(callCostUsd('claude-sonnet-5-5', { inputTokens: 38_000, outputTokens: 1_600 }, 3)).toBeCloseTo(0.122, 6);
  });

  it('matches a served id with a date suffix, and never under-prices an unknown model', () => {
    expect(priceFor('gpt-5-2025-08-07')).toEqual(MODEL_PRICES['gpt-5']);
    expect(priceFor('claude-sonnet-5-5')).toEqual(MODEL_PRICES['claude-sonnet-5-5']);
    expect(priceFor('mystery-model')).toEqual(UNKNOWN_MODEL_PRICE);
    for (const p of Object.values(MODEL_PRICES)) {
      expect(UNKNOWN_MODEL_PRICE.inputPerMillion).toBeGreaterThanOrEqual(p.inputPerMillion);
      expect(UNKNOWN_MODEL_PRICE.outputPerMillion).toBeGreaterThanOrEqual(p.outputPerMillion);
      expect(UNKNOWN_MODEL_PRICE.perSearch).toBeGreaterThanOrEqual(p.perSearch);
    }
  });

  it('does not take a differently named model for a listed one', () => {
    // Another model that shares the listed id's start, such as a "pro" variant, may cost more.
    expect(priceFor('gpt-5-pro')).toEqual(UNKNOWN_MODEL_PRICE);
    expect(priceFor('gpt-50')).toEqual(UNKNOWN_MODEL_PRICE);
  });

  it('prices the worst single call at 150,000 input and 16,000 output tokens with 5 searches', () => {
    expect(WORST_CALL).toEqual({ inputTokens: 150_000, outputTokens: 16_000, searches: 5 });
    expect(worstCallCostUsd('claude-sonnet-5-5')).toBeCloseTo(0.3 + 0.16 + 0.05, 6);
    expect(worstCallCostUsd('mystery-model')).toBeCloseTo(0.75 + 0.4 + 0.05, 6);
  });
});
