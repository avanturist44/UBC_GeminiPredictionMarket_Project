/** BTC paper agent limits. Money is represented in ten-thousandths of a dollar. */
export const AGENT_LIMITS = { bankroll: 10_000_000n, perTrade: 200_000n, stake: 100_000n,
  exposure: 1_500_000n, dailyLoss: 500_000n, dailyTrades: 30 };

export function agentLimitReason(input: {
  enabled: boolean; halted: boolean; pnl: bigint; exposure: bigint;
  balance: bigint; tradeCount: number; hasPosition: boolean;
}): string | null {
  if (!input.enabled) return 'trading disabled';
  if (input.halted) return 'agent halted';
  if (input.pnl <= -AGENT_LIMITS.dailyLoss) return 'daily loss stop';
  if (input.hasPosition) return 'position already exists';
  if (input.tradeCount >= AGENT_LIMITS.dailyTrades) return 'daily trade limit';
  if (input.exposure >= AGENT_LIMITS.exposure) return 'open exposure limit';
  if (input.balance <= 0n) return 'paper bankroll exhausted';
  return null;
}
