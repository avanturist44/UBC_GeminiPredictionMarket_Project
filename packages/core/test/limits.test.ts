import { expect, it } from 'vitest';
import { agentLimitReason } from '../src/limits';

const base = { enabled: true, halted: false, pnl: 0n, exposure: 0n, balance: 10_000_000n,
  tradeCount: 0, hasPosition: false };
it('checks both sides of the loss, exposure, balance and count boundaries', () => {
  expect(agentLimitReason({ ...base, pnl: -499_999n })).toBeNull();
  expect(agentLimitReason({ ...base, pnl: -500_000n })).toBe('daily loss stop');
  expect(agentLimitReason({ ...base, exposure: 1_499_999n })).toBeNull();
  expect(agentLimitReason({ ...base, exposure: 1_500_000n })).toBe('open exposure limit');
  expect(agentLimitReason({ ...base, balance: 1n })).toBeNull();
  expect(agentLimitReason({ ...base, balance: 0n })).toBe('paper bankroll exhausted');
  expect(agentLimitReason({ ...base, tradeCount: 29 })).toBeNull();
  expect(agentLimitReason({ ...base, tradeCount: 30 })).toBe('daily trade limit');
  expect(agentLimitReason({ ...base, enabled: false })).toBe('trading disabled');
  expect(agentLimitReason({ ...base, halted: true })).toBe('agent halted');
  expect(agentLimitReason({ ...base, hasPosition: true })).toBe('position already exists');
});
