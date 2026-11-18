import { expect, it } from 'vitest';
import { evaluateMomentum, type MomentumInput } from '../src/momentum';
const base: MomentumInput = { nowMs: 1_000_000, expiryMs: 1_300_000, marketState: 'open',
  strike: 100, indexPrice: 102, indexObservedAtMs: 1_000_000, volatilityPerMinute: 0.001,
  quote: { observedAtMs: 1_000_000, bid: 0.48, ask: 0.5, bidSize: 3, askSize: 7 } };
it('accepts the 3/12-minute, 10-second and six-cent spread boundaries', () => {
  for (const minutes of [3, 12]) expect(evaluateMomentum({ ...base, expiryMs: base.nowMs + minutes * 60_000 }).decision).toBe('trade');
  for (const minutes of [2.999, 12.001]) expect(evaluateMomentum({ ...base, expiryMs: base.nowMs + minutes * 60_000 }).decision).toBe('skip');
  expect(evaluateMomentum({ ...base, indexObservedAtMs: base.nowMs - 10_000 }).decision).toBe('trade');
  expect(evaluateMomentum({ ...base, indexObservedAtMs: base.nowMs - 10_001 }).decision).toBe('skip');
  expect(evaluateMomentum({ ...base, quote: { ...base.quote!, bid: 0.44 } }).decision).toBe('trade');
  expect(evaluateMomentum({ ...base, quote: { ...base.quote!, bid: 0.4399 } }).decision).toBe('skip');
});
it('uses the executable side price and size, and rejects empty or future data', () => {
  expect(evaluateMomentum(base)).toMatchObject({ decision: 'trade', side: 'yes', entryPrice: 0.5, availableQuantity: 7 });
  expect(evaluateMomentum({ ...base, indexPrice: 98 })).toMatchObject({ decision: 'trade', side: 'no', entryPrice: 0.52, availableQuantity: 3 });
  for (const change of [{ bidSize: 0 }, { askSize: 0 }, { observedAtMs: base.nowMs + 1 }]) {
    expect(evaluateMomentum({ ...base, quote: { ...base.quote!, ...change } }).decision).toBe('skip');
  }
  expect(evaluateMomentum({ ...base, marketState: 'post_only' }).decision).toBe('skip');
  expect(evaluateMomentum({ ...base, indexPrice: 100 })).toMatchObject({ decision: 'skip', reason: 'edge below eight cents' });
});
