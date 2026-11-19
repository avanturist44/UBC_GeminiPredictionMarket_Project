/**
 * The shapes the Markets pages and their API routes exchange. This file is imported by
 * browser code, so it holds types and pure helpers only.
 */

export interface MarketView {
  /** Gemini's instrument symbol, verbatim. */
  symbol: string;
  eventTicker: string;
  title: string;
  contractLabel: string | null;
  category: string | null;
  /** ISO time, or null for a market with no end date. */
  expiryAt: string | null;
  /** ISO time a short crypto window opens (when its strike is set). Null for other markets. */
  opensAt: string | null;
  /** Gemini's marketState. Anything other than `open` is not tradable. */
  marketState: string | null;
  strike: string | null;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
  /** Halfway between the YES bid and ask, 0 to 1. Null unless the book has both sides. */
  yesMid: number | null;
  resolutionSide: 'yes' | 'no' | null;
  thesesYes: number;
  thesesNo: number;
  updatedAt: string;
}

export interface MarketsResponse {
  asOf: string;
  markets: MarketView[];
}

export interface ChartPoint {
  /** Milliseconds since the epoch. */
  t: number;
  /** YES price, 0 to 1. */
  price: number;
}

/**
 * What the chart's line is made of: midpoints of the bid and ask, or, for a market whose
 * book has never had both sides, last trade prices.
 */
export type ChartSeries = 'midpoint' | 'lastTrade';

export interface ThesisMarker {
  id: string;
  headline: string;
  side: 'yes' | 'no';
  probabilityYes: number;
  authorKind: 'agent' | 'human';
  authorName: string;
  /** Publish time in milliseconds. Null if the thesis has none recorded. */
  t: number | null;
  /** The market's YES price when it was published. Null if nothing was recorded by then. */
  price: number | null;
}

export interface GroupAverage {
  /** Average probability of YES across the group's theses, 0 to 1. */
  average: number | null;
  count: number;
}

export interface Disagreement {
  /** The midpoint, or the last trade when a side of the book is empty. */
  marketPrice: number | null;
  ai: GroupAverage;
  human: GroupAverage;
}

export interface MarketDetailResponse {
  asOf: string;
  market: MarketView;
  points: ChartPoint[];
  series: ChartSeries;
  theses: ThesisMarker[];
  disagreement: Disagreement;
  /** The event's page on Gemini's site. */
  geminiUrl: string;
}

export interface ApiError {
  code: string;
  message: string;
}

export type MarketSort = 'expiry' | 'theses';

const expiryTime = (market: MarketView) =>
  market.expiryAt === null ? Number.POSITIVE_INFINITY : Date.parse(market.expiryAt);

const byExpiry = (a: MarketView, b: MarketView) =>
  expiryTime(a) - expiryTime(b) || a.symbol.localeCompare(b.symbol);

/** A sorted copy: soonest expiry first, or most theses first. */
export function sortMarkets(markets: readonly MarketView[], sort: MarketSort): MarketView[] {
  const copy = [...markets];
  if (sort === 'expiry') return copy.sort(byExpiry);
  return copy.sort(
    (a, b) => b.thesesYes + b.thesesNo - (a.thesesYes + a.thesesNo) || byExpiry(a, b),
  );
}

const pointsApart = (a: number, b: number) => Math.round((a - b) * 100);
const pointWord = (points: number) => (Math.abs(points) === 1 ? 'point' : 'points');

/**
 * The disagreement in sentences: how far each group's average sits from the market price,
 * and how far the two groups sit from each other. Empty when there is nothing to compare.
 */
export function disagreementLines({ marketPrice, ai, human }: Disagreement): string[] {
  const lines: string[] = [];
  const againstMarket = (who: string, average: number | null) => {
    if (average === null || marketPrice === null) return;
    const gap = pointsApart(average, marketPrice);
    lines.push(
      gap === 0
        ? `${who} agree with the market.`
        : `${who} are ${Math.abs(gap)} ${pointWord(gap)} ${gap > 0 ? 'above' : 'below'} the market.`,
    );
  };
  againstMarket('AI agents', ai.average);
  againstMarket('People', human.average);
  if (ai.average !== null && human.average !== null) {
    const gap = pointsApart(ai.average, human.average);
    lines.push(
      gap === 0
        ? 'AI agents and people agree with each other.'
        : `AI agents are ${Math.abs(gap)} ${pointWord(gap)} ${gap > 0 ? 'above' : 'below'} people.`,
    );
  }
  return lines;
}
