/**
 * The shapes the leaderboard, author pages, the live strip and the account page exchange
 * with the API routes. Imported by browser code, so it holds types and pure helpers only.
 */
import type { AuthorRecordView, MeResponse, ThesisCardView } from './thesis-view';

export interface LeaderboardRow {
  id: string;
  name: string;
  kind: 'agent' | 'human';
  record: AuthorRecordView;
  /** Payout minus cost over the author's own settled positions, in test dollars. */
  profitUsd: string;
  /** Public theses in total, resolved or not. */
  theses: number;
}

export interface LeaderboardResponse {
  asOf: string;
  authors: LeaderboardRow[];
}

export type LeaderboardSort = 'brier' | 'profit';

/**
 * A ranked copy. By Brier score the best forecaster comes first, and authors with nothing
 * resolved yet go last, since they have no score. By profit the largest gain comes first.
 * Ties go to the author with more resolved theses, then by name so the order is stable.
 */
export function rankAuthors(authors: readonly LeaderboardRow[], sort: LeaderboardSort): LeaderboardRow[] {
  const tieBreak = (a: LeaderboardRow, b: LeaderboardRow) =>
    b.record.resolved - a.record.resolved || a.name.localeCompare(b.name);
  return [...authors].sort((a, b) => {
    if (sort === 'profit') return Number(b.profitUsd) - Number(a.profitUsd) || tieBreak(a, b);
    if (a.record.brier === null || b.record.brier === null) {
      if (a.record.brier === b.record.brier) return tieBreak(a, b);
      return a.record.brier === null ? 1 : -1;
    }
    return a.record.brier - b.record.brier || tieBreak(a, b);
  });
}

/** Under this many resolved theses a record says little, and the pages say so. */
export const EARLY_SAMPLE = 20;

export interface AgentStatusView {
  halted: boolean;
  haltReason: string | null;
  tradesToday: number;
  realizedPnlTodayUsd: string;
  openExposureUsd: string;
}

export interface AuthorView extends LeaderboardRow {
  /** How an agent trades, in its own words. Null for people. */
  strategySummary: string | null;
  /** How an agent's day is going. Null for people. */
  agentStatus: AgentStatusView | null;
  /** The hard limits an agent trades within. Empty for people. */
  limits: Array<{ label: string; value: string }>;
}

export interface AuthorResponse {
  asOf: string;
  author: AuthorView;
  /** The author's public theses, newest first. */
  theses: ThesisCardView[];
}

export interface ActivityItemView {
  tipId: string;
  status: 'paid' | 'refunded';
  amountUsdc: string;
  settleTx: string | null;
  thesisId: string;
  outcome: 'right' | 'wrong' | 'void' | null;
  authorName: string;
  marketTitle: string;
  at: string;
}

export interface ActivityResponse {
  asOf: string;
  items: ActivityItemView[];
}

/** USDC to the cent: "0.250000" becomes "0.25". */
export const usdc = (amount: string) => Number(amount).toFixed(2);

/** One line of the live strip: who was right or wrong, and where the tip went. */
export function activityText(item: ActivityItemView): string {
  const amount = `${usdc(item.amountUsdc)} USDC`;
  if (item.status === 'paid') return `${item.authorName} was right on ${item.marketTitle}: ${amount} paid from escrow`;
  if (item.outcome === 'wrong') return `${item.authorName} was wrong on ${item.marketTitle}: ${amount} returned to the tipper`;
  return `${item.marketTitle} had no result: ${amount} returned to the tipper`;
}

export interface PositionView {
  tradeId: string;
  /** Null for a trade that is not tied to a thesis. */
  thesisId: string | null;
  headline: string | null;
  marketSymbol: string;
  marketTitle: string;
  contractLabel: string | null;
  expiryAt: string | null;
  /** The position behind the user's own thesis, as opposed to a copy of someone else's. */
  own: boolean;
  side: 'yes' | 'no';
  quantity: string;
  price: string;
  costUsd: string;
  /** Set once the market has resolved. */
  payoutUsd: string | null;
  settled: boolean;
  /** What one contract of this side is worth now. Null once settled, or with no price known. */
  markPrice: string | null;
  /** What the position is worth now. Null once settled: the payout says it. */
  valueUsd: string | null;
}

/** One moment of the account line: epoch milliseconds and dollars. */
export interface PortfolioPoint {
  t: number;
  v: number;
}

export interface PortfolioView {
  /** Cash plus open positions at current prices. */
  valueUsd: string;
  /** What the account held before its first position. */
  startUsd: string;
  /** Value less start. */
  changeUsd: string;
  /** Open positions at current prices. */
  openValueUsd: string;
  /** The first position, where the line starts. Null before any trade. */
  since: string | null;
  /** The account value from the first position to now. Empty before any trade. */
  points: PortfolioPoint[];
}

export interface AccountStatsView {
  /** Authors whose theses this user has copied. */
  copying: number;
  /** Other people who have copied a thesis this user wrote. */
  copiers: number;
  /** Tips paid to this user as an author. */
  tipsEarnedUsdc: string;
}

export interface TipView {
  tipId: string;
  thesisId: string;
  headline: string;
  amountUsdc: string;
  status: 'pending' | 'escrowed' | 'paid' | 'refunded' | 'failed';
  depositTx: string | null;
  settleTx: string | null;
}

export interface AccountResponse extends MeResponse {
  asOf: string;
  /** When this guest session began. */
  joinedAt: string;
  portfolio: PortfolioView;
  stats: AccountStatsView;
  positions: PositionView[];
  tips: TipView[];
}

/** What a tip's status means to the person who sent it. */
export function tipStatusText(status: TipView['status']): string {
  switch (status) {
    case 'pending':
      return 'On its way to escrow';
    case 'escrowed':
      return 'In escrow until the market resolves';
    case 'paid':
      return 'Paid to the author, who was right';
    case 'refunded':
      return 'Returned to you';
    case 'failed':
      return 'Not sent. Nothing left your wallet';
  }
}

/** Profit or loss with its sign: "+$3.04", "-$4.96". */
export function signedUsd(amount: number): string {
  const text = `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (Math.abs(amount) < 0.005) return text;
  return amount > 0 ? `+${text}` : `-${text}`;
}
