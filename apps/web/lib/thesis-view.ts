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
  viewerIsAuthor: boolean;
}

export interface ThesisResponse {
  asOf: string;
  thesis: ThesisDetailView;
}

export interface FeedResponse {
  asOf: string;
  kind: 'agent' | 'human';
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

/** Where a transaction can be read on the Arc testnet explorer. */
export const EXPLORER_TX = 'https://explorer.testnet.arc.io/tx/';
export const EXPLORER_ADDRESS = 'https://explorer.testnet.arc.io/address/';
/** True for a real transaction hash, as opposed to a marker that a call was already done. */
export const isTxHash = (value: string | null | undefined): value is string => !!value && /^0x[0-9a-fA-F]{64}$/.test(value);

export interface SubmitResponse {
  id: string;
  status: 'auditing';
}

/** "7 of 11 right, Brier 0.19", or a plain sentence when nothing has resolved. */
export function recordText(record: AuthorRecordView): string {
  if (record.resolved === 0) return 'No resolved theses yet';
  const score = record.brier === null ? '' : `, Brier ${record.brier.toFixed(2)}`;
  return `${record.right} of ${record.resolved} right${score}`;
}
