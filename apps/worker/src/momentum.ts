export interface MomentumInput {
  nowMs: number;
  expiryMs: number;
  marketState: string | null;
  strike: number;
  indexPrice: number;
  indexObservedAtMs: number;
  /** Standard deviation of log returns over a one-minute interval. */
  volatilityPerMinute: number;
  /** YES top of book. Buying NO uses the complement of the YES bid. */
  quote: { observedAtMs: number; bid: number; ask: number; bidSize: number; askSize: number } | null;
}

export type MomentumDecision =
  | { decision: 'skip'; reason: string }
  | { decision: 'trade'; side: 'yes' | 'no'; probabilityYes: number; entryPrice: number; availableQuantity: number; edge: number };

const MIN_EDGE = 0.08;
const MAX_SPREAD = 0.06;
const MAX_DATA_AGE_MS = 10_000;

function isFresh(observedAtMs: number, nowMs: number): boolean {
  const age = nowMs - observedAtMs;
  return age >= 0 && age <= MAX_DATA_AGE_MS;
}

/** Standard normal CDF using a polynomial approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

export function evaluateMomentum(input: MomentumInput): MomentumDecision {
  const { nowMs, expiryMs, marketState, strike, indexPrice, indexObservedAtMs, volatilityPerMinute, quote } = input;
  const minutesLeft = (expiryMs - nowMs) / 60_000;

  if (marketState !== 'open') return { decision: 'skip', reason: 'market not open' };
  if (!Number.isFinite(minutesLeft) || minutesLeft < 3 || minutesLeft > 12) {
    return { decision: 'skip', reason: 'outside entry window' };
  }
  if (![strike, indexPrice, volatilityPerMinute].every((value) => Number.isFinite(value) && value > 0)) {
    return { decision: 'skip', reason: 'missing or invalid strike, index, or volatility' };
  }
  if (!isFresh(indexObservedAtMs, nowMs)) return { decision: 'skip', reason: 'stale index price' };
  if (!quote || !isFresh(quote.observedAtMs, nowMs)) return { decision: 'skip', reason: 'missing or stale book' };

  const { bid, ask, bidSize, askSize } = quote;
  if (![bid, ask, bidSize, askSize].every(Number.isFinite) ||
      bid <= 0 || ask >= 1 || ask < bid || bidSize <= 0 || askSize <= 0) {
    return { decision: 'skip', reason: 'invalid or one-sided book' };
  }
  if (ask - bid > MAX_SPREAD + 1e-12) return { decision: 'skip', reason: 'spread too wide' };

  const z = (Math.log(indexPrice) - Math.log(strike)) / (volatilityPerMinute * Math.sqrt(minutesLeft));
  if (Number.isNaN(z)) return { decision: 'skip', reason: 'invalid volatility scale' };
  const probabilityYes = normalCdf(z);
  const yesEdge = probabilityYes - ask;
  const noAsk = 1 - bid;
  const noEdge = (1 - probabilityYes) - noAsk;
  if (Math.max(yesEdge, noEdge) < MIN_EDGE - 1e-12) {
    return { decision: 'skip', reason: 'edge below eight cents' };
  }
  if (yesEdge >= noEdge) {
    return { decision: 'trade', side: 'yes', probabilityYes, entryPrice: ask, availableQuantity: askSize, edge: yesEdge };
  }
  return { decision: 'trade', side: 'no', probabilityYes, entryPrice: noAsk, availableQuantity: bidSize, edge: noEdge };
}
