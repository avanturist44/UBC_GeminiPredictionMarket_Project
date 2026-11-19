'use client';

import { MessageCircle } from 'lucide-react';
import { MAX_QUOTE_AGE_MS } from '@thesis/core/browser';
import Link from 'next/link';
import { AuditBadge } from '@/components/audit';
import { CopyTrade } from '@/components/copy-trade';
import { LikeButton } from '@/components/like-button';
import { OddsLine } from '@/components/odds-line';
import { SidePill } from '@/components/thesis-card';
import { cents, percent, timeLeft, usd } from '@/lib/format';
import { ago } from '@/lib/spark';
import { recordText, type ThesisCardView } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

/** Initials on a plain disc for people, on a rounded square for agents. */
export function Avatar({ name, kind }: { name: string; kind: 'agent' | 'human' }) {
  const initials =
    name
      .split(/[\s_-]+/)
      // Words only: "Guest 1538" is G, not G1.
      .filter((part) => /^[a-z]/i.test(part))
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-10 shrink-0 items-center justify-center bg-secondary text-sm font-medium',
        kind === 'agent' ? 'rounded-lg text-primary' : 'rounded-full text-muted-foreground',
      )}
    >
      {initials}
    </span>
  );
}

function KindTag({ kind }: { kind: 'agent' | 'human' }) {
  return (
    <span
      className={cn(
        'rounded border px-1 text-xs leading-5 font-medium',
        kind === 'agent' ? 'border-primary/50 text-primary' : 'border-input text-muted-foreground',
      )}
    >
      {kind === 'agent' ? 'AI' : 'Human'}
    </span>
  );
}

/** Cents the side argued has moved since the author bought. Null without both prices. */
function moveSinceEntry(thesis: ThesisCardView): number | null {
  if (thesis.entryPrice === null || thesis.currentPrice === null) return null;
  return Math.round((Number(thesis.currentPrice) - Number(thesis.entryPrice)) * 100);
}

/** The position: the side, the price paid against now, the odds line, and what the author staked. */
function Position({ thesis, now }: { thesis: ThesisCardView; now: Date }) {
  const resolved = thesis.status === 'resolved' && thesis.outcome !== null;
  const move = moveSinceEntry(thesis);
  const trend = resolved
    ? thesis.outcome === 'right'
      ? 'up'
      : thesis.outcome === 'wrong'
        ? 'down'
        : 'flat'
    : move === null || move === 0
      ? 'flat'
      : move > 0
        ? 'up'
        : 'down';
  const left = timeLeft(thesis.market.expiryAt ? new Date(thesis.market.expiryAt) : null, now);
  const tips = Number(thesis.tipsUsdc);
  const position = thesis.position;
  // The "now" price is the last one recorded. Say so when it is old, rather than pass it off as live.
  const paused = !resolved && !left.over && now.getTime() - Date.parse(thesis.market.quoteAt) > MAX_QUOTE_AGE_MS;

  return (
    <div className="mt-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 text-sm">
            <SidePill side={thesis.side} />
            <span className="text-muted-foreground">
              Puts YES at <span className="font-medium text-foreground tabular-nums">{percent(thesis.probabilityYes)}</span>
            </span>
          </div>
          {resolved ? (
            <p
              className={cn(
                'text-2xl font-medium tabular-nums',
                thesis.outcome === 'right' && 'text-yes',
                thesis.outcome === 'wrong' && 'text-no',
              )}
            >
              {thesis.outcome === 'right' ? 'Right' : thesis.outcome === 'wrong' ? 'Wrong' : 'Voided'}
            </p>
          ) : (
            <p className="text-2xl font-medium tabular-nums">
              {cents(thesis.entryPrice)}
              <span className="mx-1.5 text-muted-foreground" aria-label="now">
                →
              </span>
              {cents(thesis.currentPrice)}
            </p>
          )}
          <p className="flex flex-wrap gap-x-3 text-[13px] tabular-nums text-muted-foreground">
            {resolved ? (
              <span>
                {position?.payoutUsd != null ? `Paid ${usd(position.payoutUsd)} on ${usd(position.costUsd)}` : 'Settled'}
              </span>
            ) : (
              <>
                {paused && <span className="text-foreground">Prices not updating</span>}
                {!paused && move !== null && move !== 0 && (
                  <span className={move > 0 ? 'text-yes' : 'text-no'}>
                    {move > 0 ? '+' : '−'}
                    {Math.abs(move)}¢ since entry
                  </span>
                )}
                {!paused && move === 0 && <span>Unchanged since entry</span>}
                <span>
                  {left.over ? 'Closed, awaiting result' : thesis.market.expiryAt ? `Closes in ${left.text}` : left.text}
                </span>
              </>
            )}
          </p>
        </div>
        {thesis.spark && <OddsLine spark={thesis.spark} trend={trend} />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[13px] tabular-nums text-muted-foreground">
        {position && <span>Staked {usd(position.costUsd)}</span>}
        {tips > 0 && <span>{tips.toFixed(2)} USDC tipped</span>}
        {thesis.social.copies > 0 && (
          <span>
            {thesis.social.copies} {thesis.social.copies === 1 ? 'copy' : 'copies'}
          </span>
        )}
      </div>
    </div>
  );
}

/** One thesis in the Home feed: who, on what, why, the position, and what you can do with it. */
export function Post({ thesis, now }: { thesis: ThesisCardView; now: Date }) {
  const href = `/thesis/${thesis.id}`;
  return (
    <article className="border-b border-border px-4 py-5 sm:px-6">
      <header className="flex items-start gap-3">
        <Link href={`/authors/${thesis.author.id}`} tabIndex={-1} aria-hidden>
          <Avatar name={thesis.author.name} kind={thesis.author.kind} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-[15px]">
            <Link href={`/authors/${thesis.author.id}`} className="truncate font-medium hover:underline">
              {thesis.author.name}
            </Link>
            <KindTag kind={thesis.author.kind} />
            <time dateTime={thesis.publishedAt ?? undefined} className="shrink-0 text-sm text-muted-foreground">
              {ago(thesis.publishedAt, now)}
            </time>
          </p>
          <p className="text-[13px] text-muted-foreground">{recordText(thesis.author.record)}</p>
        </div>
        <div className="shrink-0 pt-0.5">
          <AuditBadge audit={thesis.audit} compact />
        </div>
      </header>

      <Link
        href={`/markets/${encodeURIComponent(thesis.market.symbol)}`}
        className="mt-3 block text-[13px] text-muted-foreground hover:text-foreground"
      >
        {thesis.market.title}
        {thesis.market.contractLabel && `, ${thesis.market.contractLabel}`}
      </Link>
      <h2 className="mt-1 text-[17px] leading-snug font-medium">
        <Link href={href} className="hover:underline">
          {thesis.headline}
        </Link>
      </h2>
      <p className="mt-1.5 line-clamp-3 text-[15px] leading-relaxed text-muted-foreground">{thesis.body}</p>

      <Position thesis={thesis} now={now} />

      <footer className="mt-2 flex items-center gap-1">
        <LikeButton
          thesisId={thesis.id}
          liked={thesis.social.liked}
          likes={thesis.social.likes}
          disabled={thesis.viewerIsAuthor}
        />
        <Link
          href={`${href}#comments`}
          aria-label={`${thesis.social.comments} ${thesis.social.comments === 1 ? 'comment' : 'comments'}`}
          className="inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm tabular-nums text-muted-foreground transition-colors hover:text-foreground"
        >
          <MessageCircle aria-hidden className="size-[18px]" strokeWidth={1.75} />
          {thesis.social.comments}
        </Link>
        <div className="ml-auto">
          <CopyTrade thesis={thesis} viewerIsAuthor={thesis.viewerIsAuthor} compact />
        </div>
      </footer>
    </article>
  );
}
