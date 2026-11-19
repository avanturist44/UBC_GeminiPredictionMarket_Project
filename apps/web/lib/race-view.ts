/**
 * What `/api/race/[pair]` sends: two agents racing from the same bankroll. Plain data, safe
 * to import from client components.
 *
 * Account value = the bankroll, minus what the agent paid for its positions, plus what
 * settled positions paid out, plus open positions at the market's current midpoint.
 * Everything comes from recorded trades and recorded prices.
 */

export type RaceSlot = 'a' | 'b';

export interface RaceMarketRef {
  symbol: string;
  title: string;
  contractLabel: string | null;
}

export interface RacePositionView {
  tradeId: string;
  market: RaceMarketRef;
  side: 'yes' | 'no';
  quantity: string;
  /** What one contract cost when the position opened. */
  entryPrice: string;
  /** What one contract of this side is worth now, at the midpoint. Null with no quote. */
  markPrice: string | null;
  costUsd: string;
  valueUsd: string;
  pnlUsd: string;
  openedAt: string;
  thesisId: string | null;
}

export interface RaceSideView {
  slot: RaceSlot;
  agentKey: string;
  name: string;
  authorId: string | null;
  strategy: string | null;
  valueUsd: string;
  /** Account value minus the bankroll. */
  changeUsd: string;
  tradeCount: number;
  positions: RacePositionView[];
  /** The thesis behind its newest open position, or its newest thesis. */
  thesis: { id: string; headline: string; body: string; probabilityYes: string; at: string | null } | null;
  /** Its most recent decision, traded or not. */
  lastLook: { decision: 'trade' | 'skip'; reason: string; at: string; market: string | null } | null;
}

/** One moment of the race: both account values, in dollars. */
export interface RacePoint {
  t: number;
  a: number;
  b: number;
}

/** A position opening, drawn on its agent's line. */
export interface RaceMark {
  id: string;
  t: number;
  slot: RaceSlot;
  side: 'yes' | 'no';
  value: number;
  market: string;
}

export interface RaceResponse {
  asOf: string;
  pair: string;
  bankrollUsd: number;
  /** When the first position opened. Null before either agent traded. */
  since: string | null;
  a: RaceSideView;
  b: RaceSideView;
  /** Who is ahead now. Null when level. */
  leader: RaceSlot | null;
  /** How far ahead, always positive. */
  leadUsd: string;
  /** The market that accounts for most of the lead, or the latest one traded when level. */
  deal: (RaceMarketRef & { label: string }) | null;
  /** "Watch News Desk outperform Fade", or "Watch News Desk and Fade trade" when that is not true. */
  headline: string;
  points: RacePoint[];
  marks: RaceMark[];
}

/** A date that reads the same on the server and in the browser. */
export function raceDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
