/**
 * The shapes the feeds, the thesis page and the editor exchange with the API routes.
 * This file is imported by browser code, so it holds types and pure helpers only.
 */

export interface AuthorRecordView {
  resolved: number;
  right: number;
  /** Lower is better. 0.25 is what a coin flip scores. */
  brier: number | null;
  /** The market price's own score on the same theses. */
  marketBrier: number | null;
}

export interface AuditSummary {
  verdict: 'pass' | 'flagged' | 'blocked';
  /** Claims the auditor checked. */
  checked: number;
  /** Claims found unsupported or contradicted. */
  problems: number;
  /** True when no language model was configured and only the phrase screen ran. */
  screenOnly: boolean;
  /** The screen found a claim of non-public knowledge. Such a thesis is never published. */
  insideInfo: boolean;
}

export interface ThesisCardView {
  id: string;
  status: 'draft' | 'auditing' | 'blocked' | 'published' | 'resolved';
  outcome: 'right' | 'wrong' | 'void' | null;
  publishedAt: string | null;
  author: {
    id: string;
    name: string;
    kind: 'agent' | 'human';
    agentKey: string | null;
    record: AuthorRecordView;
  };
  market: {
    symbol: string;
    title: string;
    contractLabel: string | null;
    expiryAt: string | null;
    marketState: string | null;
    /** When the market's quote was last recorded. Copies are refused on a quote older than two minutes. */
    quoteAt: string;
    resolutionSide: 'yes' | 'no' | null;
  };
  side: 'yes' | 'no';
  /** The author's probability of YES, 0 to 1. */
  probabilityYes: number;
  headline: string;
  body: string;
  /** What the author paid per contract for the side argued. */
  entryPrice: string | null;
  /** What that side costs now. Null when nobody is selling it. */
  currentPrice: string | null;
  audit: AuditSummary | null;
  position: { quantity: string; costUsd: string; payoutUsd: string | null; status: string } | null;
  /** Test USDC from copiers, held in escrow or already paid out. */
  tipsUsdc: string;
  /** The thesis is recorded in the escrow contract, so a copy can carry a tip. */
  tipsOpen: boolean;
  /** Likes, comments and copies, and whether the viewer has liked it. */
  social: SocialView;
  /** The viewer wrote it, so they cannot copy, tip or like it. */
  viewerIsAuthor: boolean;
  /** The price of the side argued, from a little before publication to now. Null when nothing was recorded. */
  spark: SparkView | null;
}

export interface SocialView {
  likes: number;
  comments: number;
  /** Filled copy trades. */
  copies: number;
  liked: boolean;
}

export interface SparkView {
  /** Milliseconds since the epoch, and the price of the side argued, 0 to 1. */
  points: Array<{ t: number; p: number }>;
  /** When the thesis was published, in milliseconds. */
  entryT: number | null;
  /** What the author paid per contract. */
  entryPrice: number | null;
  /** The window the line covers, in milliseconds. */
  from: number;
  to: number;
}

export interface AuditClaimView {
  text: string;
  status: 'supported' | 'unsupported' | 'contradicted' | 'unverifiable';
  sourceUrl: string | null;
  note: string | null;
}

export interface ThesisDetailView extends ThesisCardView {
  evidence: Array<{ claim: string; url: string }>;
  claims: AuditClaimView[];
  auditModel: string | null;
  /** What the audit found wrong with a thesis that was already public when it was audited. */
  auditWarning: string | null;
  /** Why the thesis was blocked, or why its author's trade was not placed. Author only. */
  problem: string | null;
  contentHash: string | null;
  onchainId: string;
  registerTx: string | null;
  /** The escrow contract's address on Arc testnet. Null when none is configured. */
  escrowAddress: string | null;
}

export interface ThesisResponse {
  asOf: string;
  thesis: ThesisDetailView;
}

export type FeedKind = 'all' | 'agent' | 'human';

export interface FeedResponse {
  asOf: string;
  kind: FeedKind;
  theses: ThesisCardView[];
  /** Pass as `cursor` to get the next page. Null at the end. */
  nextCursor: string | null;
  /** Agents that have published, for the filter. Empty on the human feed. */
  agents: Array<{ agentKey: string; displayName: string }>;
}

export interface MeResponse {
  id: string;
  displayName: string;
  paperBalanceUsd: string;
  maxPerTradeUsd: string;
  dailyCopyCapUsd: string;
  /** What the user's copy trades have cost so far this UTC day. */
  copiedTodayUsd: string;
  /** Higher limits the user asked for, and the UTC day (YYYY-MM-DD) they start. */
  pendingLimits: { maxPerTradeUsd?: string; dailyCopyCapUsd?: string; effectiveOn: string } | null;
  /** The user's wallet on Arc testnet, made the first time they tip. */
  walletAddress: string | null;
  /** Test USDC in that wallet. Null with no wallet, or when the chain could not be read. */
  tipBalanceUsdc: string | null;
}

export interface TipStatusResponse {
  id: string;
  status: 'pending' | 'escrowed' | 'paid' | 'refunded' | 'failed';
  amountUsdc: string;
  /** The transaction that moved the tip into escrow. */
  depositTx: string | null;
  /** The transaction that paid it to the author or returned it. */
  settleTx: string | null;
}

export interface CommentView {
  id: string;
  body: string;
  createdAt: string;
  displayName: string;
  /** Written by the thesis's author. */
  byAuthor: boolean;
  /** Written by the person viewing. */
  byViewer: boolean;
}

export interface CommentsResponse {
  asOf: string;
  comments: CommentView[];
}

export interface LikeResponse {
  liked: boolean;
  likes: number;
}

/** Where a transaction can be read on the Arc testnet explorer. */
export const EXPLORER_TX = 'https://explorer.testnet.arc.io/tx/';
export const EXPLORER_ADDRESS = 'https://explorer.testnet.arc.io/address/';
/** True for a real transaction hash, as opposed to a marker that a call was already done. */
export const isTxHash = (value: string | null | undefined): value is string => !!value && /^0x[0-9a-fA-F]{64}$/.test(value);

export interface SubmitResponse {
  id: string;
  status: 'auditing';
}

/** "Best AI at the end of 2026?" with contract "Gemini" reads "Best AI at the end of 2026, Gemini". */
export function marketTitle(market: { title: string; contractLabel: string | null }): string {
  return market.contractLabel ? `${market.title.replace(/\?\s*$/, '')}, ${market.contractLabel}` : market.title;
}

/**
 * What the inside-information screen found: `clear` once it ran and found nothing, `found`
 * when it flagged a claim of non-public knowledge, `pending` before any audit.
 */
export function screenStatus(audit: AuditSummary | null): 'clear' | 'found' | 'pending' {
  if (!audit) return 'pending';
  return audit.insideInfo ? 'found' : 'clear';
}

export interface ClaimTally {
  total: number;
  supported: number;
  /** Unsupported or contradicted. */
  problems: number;
  /** The check could not reach a verdict. */
  unchecked: number;
}

export function claimTally(claims: readonly AuditClaimView[]): ClaimTally {
  const count = (statuses: AuditClaimView['status'][]) => claims.filter((c) => statuses.includes(c.status)).length;
  return {
    total: claims.length,
    supported: count(['supported']),
    problems: count(['unsupported', 'contradicted']),
    unchecked: count(['unverifiable']),
  };
}

/** "3 claims: 1 flagged, 1 supported, 1 not checked", leaving out kinds with none. */
export function claimTallyText(tally: ClaimTally): string {
  if (tally.total === 0) return 'No checkable claims';
  const parts = [
    tally.problems > 0 && `${tally.problems} flagged`,
    tally.supported > 0 && `${tally.supported} supported`,
    tally.unchecked > 0 && `${tally.unchecked} not checked`,
  ].filter(Boolean);
  return `${tally.total} ${tally.total === 1 ? 'claim' : 'claims'}: ${parts.join(', ')}`;
}

type PriceFields = Pick<ThesisCardView, 'status' | 'outcome' | 'entryPrice' | 'currentPrice'>;

/** Cents the side argued has moved since the author bought. Null without both prices. */
export function moveSinceEntry(thesis: PriceFields): number | null {
  if (thesis.entryPrice === null || thesis.currentPrice === null) return null;
  return Math.round((Number(thesis.currentPrice) - Number(thesis.entryPrice)) * 100);
}

/** Which way the position is going: the price while open, the outcome once resolved. */
export function positionTrend(thesis: PriceFields): 'up' | 'down' | 'flat' {
  if (thesis.status === 'resolved' && thesis.outcome !== null) {
    return thesis.outcome === 'right' ? 'up' : thesis.outcome === 'wrong' ? 'down' : 'flat';
  }
  const move = moveSinceEntry(thesis);
  return move === null || move === 0 ? 'flat' : move > 0 ? 'up' : 'down';
}

/** "0xabde…9403": enough of a hash to recognise it, with the whole of it a click away. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

/** "7 of 11 right, Brier 0.19", or a plain sentence when nothing has resolved. */
export function recordText(record: AuthorRecordView): string {
  if (record.resolved === 0) return 'No resolved theses yet';
  const score = record.brier === null ? '' : `, Brier ${record.brier.toFixed(2)}`;
  return `${record.right} of ${record.resolved} right${score}`;
}
