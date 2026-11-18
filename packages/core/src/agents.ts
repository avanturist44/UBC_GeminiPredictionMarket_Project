import { z } from 'zod';
import type { Outcome } from './gemini/schemas';
import { BODY_MAX, EvidenceSchema, HEADLINE_MAX } from './thesis';

/**
 * Rules and decisions for the two agents that argue from what they read: `news` and `fade`.
 *
 * A model supplies a probability, a text and sources. Everything about money is decided
 * here, in code: which side, at what price at most, and whether the agent may trade at all.
 * A model never chooses a size, a price or an account.
 */

/** The limits every agent trades under. They are shown on each agent's profile. */
export const AGENT_RULES = {
  bankrollUsd: 1000,
  stakeUsd: 10,
  maxPerTradeUsd: 20,
  maxOpenExposureUsd: 150,
  dailyLossStopUsd: 50,
  maxTradesPerDay: 30,
  minPrice: 0.05,
  maxPrice: 0.95,
  maxSpread: 0.06,
  minMinutesToExpiry: 3,
} as const;

export type RuleResult = { ok: true } | { ok: false; code: string; message: string };

const no = (code: string, message: string): RuleResult => ({ ok: false, code, message });
// Prices and dollars arrive as floats here only to be compared with a limit, never summed.
const EPS = 1e-9;

export interface AgentEntry {
  halted: boolean;
  haltReason: string | null;
  /** Realized profit so far this UTC day. Negative is a loss. */
  realizedPnlTodayUsd: number;
  openExposureUsd: number;
  tradesToday: number;
  /** The agent already holds, or is waiting on, a position on this contract. */
  hasPositionOnMarket: boolean;
  /** Bankroll left: the starting bankroll plus settled profit, minus what is tied up. */
  balanceUsd: number;
  costUsd: number;
  /** What one contract of the side costs. */
  price: number;
  /** YES ask minus YES bid. Null when a side of the book is empty. */
  spread: number | null;
  minutesToExpiry: number | null;
}

/** Whether an agent may open this position. The first rule that fails is returned. */
export function checkAgentEntry(entry: AgentEntry): RuleResult {
  const r = AGENT_RULES;
  if (entry.halted) return no('halted', `Halted: ${entry.haltReason ?? 'stopped'}.`);
  if (entry.realizedPnlTodayUsd <= -r.dailyLossStopUsd + EPS) {
    return no('daily_loss_stop', `Daily loss stop: lost $${r.dailyLossStopUsd} or more today.`);
  }
  if (entry.tradesToday >= r.maxTradesPerDay) return no('daily_trades', `Already made ${r.maxTradesPerDay} trades today.`);
  if (entry.hasPositionOnMarket) return no('position_exists', 'Already holds a position on this contract.');
  if (entry.costUsd > r.maxPerTradeUsd + EPS) return no('per_trade_cap', `Over the $${r.maxPerTradeUsd} per-trade cap.`);
  if (entry.openExposureUsd + entry.costUsd > r.maxOpenExposureUsd + EPS) {
    return no('exposure_cap', `Would take open exposure over $${r.maxOpenExposureUsd}.`);
  }
  if (entry.costUsd > entry.balanceUsd + EPS) return no('bankroll', 'Not enough bankroll left.');
  if (entry.price < r.minPrice - EPS || entry.price > r.maxPrice + EPS) {
    return no('price_band', `Price is outside ${r.minPrice} to ${r.maxPrice}.`);
  }
  if (entry.spread === null) return no('spread', 'One side of the book is empty.');
  if (entry.spread > r.maxSpread + EPS) return no('spread', `Spread is wider than ${r.maxSpread}.`);
  if (entry.minutesToExpiry !== null && entry.minutesToExpiry < r.minMinutesToExpiry - EPS) {
    return no('time_to_expiry', `Less than ${r.minMinutesToExpiry} minutes to expiry.`);
  }
  return { ok: true };
}

export type AgentDecision =
  | { decision: 'trade'; side: Outcome; probabilityYes: number; limitPrice: string; edge: number }
  | { decision: 'skip'; reason: string };

const skip = (reason: string): AgentDecision => ({ decision: 'skip', reason });
/** A price as a two-decimal string, rounded down so a limit is never looser than intended. */
const floorCents = (price: number) => (Math.floor(price * 100 + 1e-9) / 100).toFixed(2);
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Picks the side whose price is at least `minEdge` below the agent's probability for it.
 * The limit price is the most the agent may pay and still keep that edge, so a fill after
 * the audit, at a worse price than the one seen now, cannot erase it.
 */
function sideWithEdge(
  probabilityYes: number,
  quote: { yesBid: string | null; yesAsk: string | null },
  minEdge: number,
): AgentDecision {
  if (quote.yesBid === null || quote.yesAsk === null) return skip('One side of the book is empty.');
  const yesAsk = Number(quote.yesAsk);
  const noAsk = 1 - Number(quote.yesBid);
  const yesEdge = probabilityYes - yesAsk;
  const noEdge = 1 - probabilityYes - noAsk;
  if (yesEdge >= minEdge - EPS) {
    return { decision: 'trade', side: 'yes', probabilityYes, limitPrice: floorCents(probabilityYes - minEdge), edge: round4(yesEdge) };
  }
  if (noEdge >= minEdge - EPS) {
    return { decision: 'trade', side: 'no', probabilityYes, limitPrice: floorCents(1 - probabilityYes - minEdge), edge: round4(noEdge) };
  }
  return skip(`Its probability is within ${Math.round(minEdge * 100)} points of the price.`);
}

/** What the `news` agent's model returns. */
export const NewsEstimateSchema = z.object({
  probability_yes: z.number().min(0.01).max(0.99),
  confidence: z.enum(['low', 'medium', 'high']),
  headline: z.string().trim().min(1).max(HEADLINE_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  evidence: z.array(EvidenceSchema).max(6),
  /** Why not to trade, when the model sees a reason. Null otherwise. */
  no_trade_reason: z.string().max(300).nullable(),
});
export type NewsEstimate = z.infer<typeof NewsEstimateSchema>;

export const NEWS_MIN_EDGE = 0.1;

/** `news` trades when its probability differs from the price by 10 points or more, it is not unsure, and it cites two sources. */
export function decideNews(
  estimate: NewsEstimate,
  quote: { yesBid: string | null; yesAsk: string | null },
): AgentDecision {
  if (estimate.no_trade_reason) return skip(`Model advised against trading: ${estimate.no_trade_reason}`);
  if (estimate.confidence === 'low') return skip('Confidence is low.');
  const sources = new Set(estimate.evidence.map((e) => e.url).filter(isHttpUrl));
  if (sources.size < 2) return skip('Fewer than two sources cited.');
  return sideWithEdge(estimate.probability_yes, quote, NEWS_MIN_EDGE);
}

export interface PricePoint {
  /** Milliseconds. */
  t: number;
  /** YES midpoint, 0 to 1. */
  price: number;
}

export interface PriceMove {
  from: number;
  to: number;
  /** `to` minus `from`. Positive when YES rose. */
  change: number;
  fromT: number;
  toT: number;
}

export const FADE_MIN_MOVE = 0.1;
export const FADE_WINDOW_MS = 30 * 60_000;
export const FADE_MIN_EDGE = 0.03;

/**
 * A move of 10 points or more over the last 30 minutes, from points given oldest first.
 * It compares the newest point with the oldest one inside the window, and needs that older
 * point to be at least 20 minutes back, so a market that has only just started being
 * recorded shows no move.
 */
export function findMove(points: readonly PricePoint[], now: number): PriceMove | null {
  const latest = points.at(-1);
  if (!latest || now - latest.t > 2 * 60_000) return null;
  const earlier = points.find((point) => point.t >= now - FADE_WINDOW_MS);
  if (!earlier || latest.t - earlier.t < 20 * 60_000) return null;
  const change = round4(latest.price - earlier.price);
  if (Math.abs(change) < FADE_MIN_MOVE - EPS) return null;
  return { from: earlier.price, to: latest.price, change, fromT: earlier.t, toT: latest.t };
}

/** What the `fade` agent's model returns after looking for news behind a move. */
export const FadeFindingSchema = z.object({
  /** Something published in the last hour explains the move. */
  explained: z.boolean(),
  explanation: z.string().max(400).nullable(),
  sources: z.array(EvidenceSchema).max(4),
});
export type FadeFinding = z.infer<typeof FadeFindingSchema>;

/** `fade` bets on half of an unexplained move reversing. An explained move is left alone. */
export function decideFade(
  move: PriceMove,
  finding: FadeFinding,
  quote: { yesBid: string | null; yesAsk: string | null },
): AgentDecision {
  if (finding.explained) return skip(`The move has an explanation: ${finding.explanation ?? 'news found'}`);
  const probabilityYes = Math.min(0.99, Math.max(0.01, round4(move.to - move.change / 2)));
  return sideWithEdge(probabilityYes, quote, FADE_MIN_EDGE);
}
