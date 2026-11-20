import { KEYWORD_SCREEN_MODEL, sideAsk } from '@thesis/core';
import type { SocialCounts, ThesisView } from '@thesis/db';
import type { AuditSummary, SparkView, ThesisCardView, ThesisDetailView } from './thesis-view';

export interface CardExtras {
  social?: SocialCounts;
  spark?: SparkView | null;
  /** The signed-in user, if any. */
  viewerUserId?: string | null;
}

/** Turns database rows into what the feeds and the thesis page send. Server side. */

function auditSummary(view: ThesisView): AuditSummary | null {
  const audit = view.audit;
  if (!audit) return null;
  return {
    verdict: audit.verdict,
    checked: audit.claims.length,
    problems: audit.claims.filter((c) => c.status === 'unsupported' || c.status === 'contradicted').length,
    screenOnly: audit.model === KEYWORD_SCREEN_MODEL,
    insideInfo: audit.insideInfo,
  };
}

export function toThesisCard(view: ThesisView, extras: CardExtras = {}): ThesisCardView {
  const { thesis, author, market, position } = view;
  const viewer = extras.viewerUserId ?? null;
  return {
    id: thesis.id,
    status: thesis.status,
    outcome: thesis.outcome,
    publishedAt: thesis.publishedAt?.toISOString() ?? null,
    author: {
      id: author.id,
      name: author.displayName,
      kind: author.kind,
      agentKey: author.agentKey,
      record: view.record,
    },
    market: {
      symbol: market.instrumentSymbol,
      title: market.title,
      contractLabel: market.contractLabel,
      expiryAt: market.expiryAt?.toISOString() ?? null,
      marketState: market.marketState,
      quoteAt: market.updatedAt.toISOString(),
      resolutionSide: market.resolutionSide,
    },
    side: thesis.side,
    probabilityYes: Number(thesis.probabilityYes),
    headline: thesis.headline,
    body: thesis.body,
    entryPrice: thesis.entryPrice,
    currentPrice: sideAsk(thesis.side, market),
    audit: auditSummary(view),
    position: position
      ? {
          quantity: position.quantity,
          costUsd: position.costUsd,
          payoutUsd: position.payoutUsd,
          status: position.status,
        }
      : null,
    tipsUsdc: view.tipsUsdc,
    tipsOpen: thesis.status === 'published' && thesis.registerTx !== null && Boolean(process.env.ESCROW_ADDRESS),
    social: extras.social ?? { likes: 0, comments: 0, copies: 0, liked: false },
    viewerIsAuthor: viewer !== null && author.userId === viewer,
    spark: extras.spark ?? null,
  };
}

/**
 * The full thesis. `problem` (why it was blocked, or why the trade was not placed) is the
 * author's business only, so it is filled in only for them.
 */
export function toThesisDetail(
  view: ThesisView,
  viewer: { userId: string | null; rejectReason: string | null },
  extras: Omit<CardExtras, 'viewerUserId'> = {},
): ThesisDetailView {
  const viewerIsAuthor = viewer.userId !== null && view.author.userId === viewer.userId;
  const blocked = view.thesis.status === 'blocked' ? (view.audit?.blockReason ?? 'The audit blocked this thesis.') : null;
  const returned = view.thesis.status === 'draft' ? viewer.rejectReason : null;
  return {
    ...toThesisCard(view, { ...extras, viewerUserId: viewer.userId }),
    evidence: view.thesis.evidence,
    claims: (view.audit?.claims ?? []).map((claim) => ({
      text: claim.text,
      status: claim.status,
      sourceUrl: claim.source_url,
      note: claim.note,
    })),
    auditModel: view.audit?.model ?? null,
    auditWarning: view.thesis.status !== 'blocked' && view.thesis.status !== 'draft' ? (view.audit?.blockReason ?? null) : null,
    problem: viewerIsAuthor ? (blocked ?? returned) : null,
    contentHash: view.thesis.contentHash,
    onchainId: view.thesis.onchainId,
    registerTx: view.thesis.registerTx,
    escrowAddress: process.env.ESCROW_ADDRESS ?? null,
  };
}
