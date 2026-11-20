'use client';

import { MAX_QUOTE_AGE_MS } from '@thesis/core/browser';
import { ArrowUpRight, Check, Copy, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { AuditPanel, ScreenLabel } from '@/components/audit';
import { Avatar } from '@/components/avatar';
import { Comments } from '@/components/comments';
import { CopyTrade } from '@/components/copy-trade';
import { InfoTip } from '@/components/info-tip';
import { LikeButton } from '@/components/like-button';
import { LoadError } from '@/components/load-error';
import { OddsLine } from '@/components/odds-line';
import { KindTag } from '@/components/post';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, contracts, percent, timeLeft, usd } from '@/lib/format';
import {
  EXPLORER_ADDRESS,
  EXPLORER_TX,
  claimTally,
  claimTallyText,
  isTxHash,
  marketTitle,
  moveSinceEntry,
  positionTrend,
  recordText,
  shortHash,
  type ThesisDetailView,
  type ThesisResponse,
} from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * One thesis. On a laptop the argument reads on the left and the author's position, with
 * Copy trade, tips and proof, stays in view on the right. On a phone the position comes
 * right after the headline.
 */

const LINE_HEIGHT = 72;

export function ThesisDetailSkeleton() {
  return (
    <div aria-hidden className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-5/6" />
        <Skeleton className="h-40 w-full" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}

/** What the author sees while their thesis is not public: where it is, and what to do. */
function AuthorStatus({ thesis }: { thesis: ThesisDetailView }) {
  if (!thesis.viewerIsAuthor || thesis.status === 'published' || thesis.status === 'resolved') return null;
  const rewrite = (
    <Link
      href={`/write?market=${encodeURIComponent(thesis.market.symbol)}`}
      className="text-primary underline-offset-4 hover:underline"
    >
      Write it again
    </Link>
  );
  if (thesis.status === 'auditing') {
    return (
      <div role="status" className="rounded-lg border border-primary p-4 text-sm">
        <p className="font-medium">The audit is running.</p>
        <p className="text-muted-foreground">
          Your thesis is being checked for inside information and its facts against sources. This
          usually takes under a minute, and this page updates on its own. Nothing has been
          charged yet.
        </p>
      </div>
    );
  }
  if (thesis.status === 'blocked') {
    return (
      <div role="alert" className="rounded-lg border border-no p-4 text-sm">
        <p className="font-medium">This thesis was blocked and is not published.</p>
        <p>{thesis.problem}</p>
        <p className="text-muted-foreground">No trade was placed and nothing was charged. {rewrite}.</p>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-lg border p-4 text-sm">
      <p className="font-medium">This thesis passed its audit but was not published.</p>
      <p>{thesis.problem}</p>
      <p className="text-muted-foreground">Nothing was charged. {rewrite} at the current price.</p>
    </div>
  );
}

/** Who wrote it, on which market, the claim, and what the screen and the fact check found. */
function Header({ thesis, mounted }: { thesis: ThesisDetailView; mounted: boolean }) {
  const tally = claimTally(thesis.claims);
  const checked = thesis.audit !== null && !thesis.audit.screenOnly;
  return (
    <header>
      <div className="flex items-center gap-3">
        <Link href={`/authors/${thesis.author.id}`} tabIndex={-1} aria-hidden>
          <Avatar name={thesis.author.name} kind={thesis.author.kind} />
        </Link>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 text-[15px]">
            <Link href={`/authors/${thesis.author.id}`} className="truncate font-medium hover:underline">
              {thesis.author.name}
            </Link>
            <KindTag kind={thesis.author.kind} />
          </p>
          <p className="text-[13px] text-muted-foreground">{recordText(thesis.author.record)}</p>
        </div>
      </div>

      <Link
        href={`/markets/${encodeURIComponent(thesis.market.symbol)}`}
        className="mt-6 inline-block text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {marketTitle(thesis.market)}
      </Link>
      <h1 className="mt-2 serif-title text-[36px] leading-[1.1] text-balance lg:text-[44px]">
        {thesis.headline}
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <ScreenLabel audit={thesis.audit} />
        {checked && (
          <a
            href="#fact-check"
            className={cn(
              'tabular-nums underline-offset-4 transition-colors hover:underline',
              tally.problems > 0 ? 'text-no' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {claimTallyText(tally)}
          </a>
        )}
        {thesis.publishedAt && mounted && (
          <span className="text-muted-foreground">
            Published{' '}
            {new Date(thesis.publishedAt).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
    </header>
  );
}

/** The element's width in pixels, kept current. 0 until it is measured in the browser. */
function useWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

function Figure({ label, children, tip }: { label: string; children: ReactNode; tip?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="flex items-center gap-1 text-[13px] text-muted-foreground">
        {label}
        {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
      </dt>
      <dd className="text-[15px] font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** A long hash shown short, with a button that copies all of it. */
function HashValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-xs" title={value}>
        {shortHash(value)}
      </span>
      <button
        type="button"
        aria-label={copied ? `${label} copied` : `Copy the ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
        className="-my-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </span>
  );
}

function ProofRow({ label, tip, children }: { label: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4">
      <dt className="flex items-center gap-1 text-muted-foreground">
        {label}
        {tip && <InfoTip label={`About the ${label.toLowerCase()}`}>{tip}</InfoTip>}
      </dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ArrowUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
    </a>
  );
}

/** Tips held for the thesis, and where it is recorded so it cannot be changed after the fact. */
function TipsAndProof({ thesis }: { thesis: ThesisDetailView }) {
  const tips = Number(thesis.tipsUsdc);
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Tips and proof</h3>
      <dl className="space-y-1 text-sm">
        <ProofRow
          label="Tips held"
          tip="Test USDC from people who copied this trade. A contract on Arc testnet holds it until the market resolves, then pays it to the author only if the thesis is right; otherwise it goes back to the tippers."
        >
          {tips > 0 ? `${tips.toFixed(2)} USDC` : <span className="text-muted-foreground">None yet</span>}
        </ProofRow>
        <ProofRow label="Recorded">
          {isTxHash(thesis.registerTx) ? (
            <ExternalLink href={EXPLORER_TX + thesis.registerTx}>Arc testnet</ExternalLink>
          ) : thesis.registerTx ? (
            'Arc testnet'
          ) : (
            <span className="text-muted-foreground">Not on-chain</span>
          )}
        </ProofRow>
        {thesis.escrowAddress && (
          <ProofRow label="Escrow">
            <ExternalLink href={EXPLORER_ADDRESS + thesis.escrowAddress}>Contract</ExternalLink>
          </ProofRow>
        )}
        {thesis.contentHash && (
          <ProofRow
            label="Content hash"
            tip="Computed from the market, side, probability, headline, body and sources, and recorded on-chain. A thesis cannot be edited or deleted after it is published."
          >
            <HashValue label="Content hash" value={thesis.contentHash} />
          </ProofRow>
        )}
        <ProofRow label="On-chain id">
          <HashValue label="On-chain id" value={thesis.onchainId} />
        </ProofRow>
      </dl>
    </div>
  );
}

/**
 * The author's position as a ticket: the side, what they paid against now, the price since
 * they bought, what the position pays, then Copy trade, then tips and proof.
 */
function PositionCard({ thesis, now }: { thesis: ThesisDetailView; now: Date }) {
  const [lineBox, lineWidth] = useWidth();
  const position = thesis.position && thesis.position.status !== 'pending' ? thesis.position : null;
  const resolved = thesis.status === 'resolved' && thesis.outcome !== null;
  const move = moveSinceEntry(thesis);
  const trend = positionTrend(thesis);
  const left = timeLeft(thesis.market.expiryAt ? new Date(thesis.market.expiryAt) : null, now);
  // The "now" price is the last one recorded. Say so when it is old, rather than pass it off as live.
  const paused = !resolved && !left.over && now.getTime() - Date.parse(thesis.market.quoteAt) > MAX_QUOTE_AGE_MS;
  const side = thesis.side.toUpperCase();
  const outcomeTone = thesis.outcome === 'right' ? 'text-yes' : thesis.outcome === 'wrong' ? 'text-no' : '';

  return (
    <section aria-labelledby="position-heading" className="rounded-xl border border-border bg-card">
      <div className="space-y-5 p-5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-6 items-center rounded-md px-2 text-[13px] font-semibold',
              thesis.side === 'yes' ? 'bg-yes/15 text-yes' : 'bg-no/15 text-no',
            )}
          >
            {side}
          </span>
          <h2 id="position-heading" className="text-sm text-muted-foreground">
            Author’s position
          </h2>
          <InfoTip label="About the author's position">
            A simulated fill at Gemini’s live price, with test money and no fees. The position is locked: it cannot
            be sold through this app before the market resolves.
          </InfoTip>
        </div>

        <div>
          {resolved ? (
            <p className={cn('text-[32px] leading-10 font-medium', outcomeTone)}>
              {thesis.outcome === 'right' ? 'Right' : thesis.outcome === 'wrong' ? 'Wrong' : 'Voided'}
            </p>
          ) : (
            <p className="text-[32px] leading-10 font-medium tabular-nums">
              {cents(thesis.entryPrice)}
              <span className="mx-2 text-muted-foreground" aria-label="now">
                →
              </span>
              {cents(thesis.currentPrice)}
            </p>
          )}
          <p className="mt-1 text-sm tabular-nums">
            {resolved ? (
              <span className="text-muted-foreground">
                {thesis.outcome === 'void'
                  ? 'Market voided, stake returned'
                  : position?.payoutUsd != null
                    ? `Paid ${usd(position.payoutUsd)} on ${usd(position.costUsd)}`
                    : 'Settled'}
              </span>
            ) : paused ? (
              <span>Prices not updating</span>
            ) : move === null ? (
              <span className="text-muted-foreground">Bought at {cents(thesis.entryPrice)}, no price now</span>
            ) : move === 0 ? (
              <span className="text-muted-foreground">Unchanged since the author bought</span>
            ) : (
              <span className={move > 0 ? 'text-yes' : 'text-no'}>
                {move > 0 ? '+' : '−'}
                {Math.abs(move)}¢ since the author bought
              </span>
            )}
          </p>
        </div>

        {thesis.spark && (
          <div ref={lineBox} style={{ height: LINE_HEIGHT }}>
            {lineWidth > 0 && (
              <OddsLine
                spark={thesis.spark}
                trend={trend}
                width={lineWidth}
                height={LINE_HEIGHT}
                className="h-auto w-full sm:w-full"
              />
            )}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          {position && (
            <>
              <Figure label="Bought">
                {contracts(position.quantity)} {side} for {usd(position.costUsd)}
              </Figure>
              <Figure label={resolved ? 'Paid' : `Pays if ${side} wins`}>
                {resolved ? usd(position.payoutUsd) : usd(position.quantity)}
              </Figure>
            </>
          )}
          <Figure label="Author’s forecast" tip="The author’s own probability that YES wins, given when they published.">
            YES {percent(thesis.probabilityYes)}
          </Figure>
          {resolved ? (
            <Figure label="Result">
              {thesis.market.resolutionSide ? `${thesis.market.resolutionSide.toUpperCase()} won` : 'Voided'}
            </Figure>
          ) : (
            <Figure label="Closes">
              {left.over ? 'Awaiting result' : thesis.market.expiryAt ? `In ${left.text}` : left.text}
            </Figure>
          )}
        </dl>
      </div>

      {/* A resolved thesis can no longer be copied, so it shows only how often it was. */}
      {(thesis.status === 'published' || thesis.social.copies > 0) && (
        <div className="space-y-2 border-t border-border p-5">
          {thesis.status === 'published' && <CopyTrade thesis={thesis} viewerIsAuthor={thesis.viewerIsAuthor} wide />}
          {thesis.social.copies > 0 && (
            <p
              className={cn(
                'text-[13px] text-muted-foreground tabular-nums',
                thesis.status === 'published' && 'text-center',
              )}
            >
              Copied {thesis.social.copies} {thesis.social.copies === 1 ? 'time' : 'times'}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-border p-5">
        <TipsAndProof thesis={thesis} />
      </div>
    </section>
  );
}

function Sources({ evidence }: { evidence: ThesisDetailView['evidence'] }) {
  return (
    <section aria-labelledby="evidence-heading" className="space-y-4">
      <h2 id="evidence-heading" className="text-lg font-medium">
        Sources the author gave
      </h2>
      <ul className="space-y-3">
        {evidence.map((item, index) => (
          <li key={index} className="space-y-0.5">
            <p className="text-[15px] leading-relaxed">{item.claim}</p>
            <ExternalLink href={item.url}>
              <span className="text-sm break-all">{new URL(item.url).hostname.replace(/^www\./, '')}</span>
            </ExternalLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ThesisDetail({ id, initial }: { id: string; initial: ThesisResponse | undefined }) {
  // While the audit runs the page checks often, so the author sees the result as it lands.
  const waiting = initial?.thesis.status === 'auditing';
  const { data, error, retry } = useLive<ThesisResponse>(`/api/theses/${id}`, initial, waiting ? 2000 : 5000);
  const { now, mounted } = useNow(initial?.asOf);

  if (!data) return error ? <LoadError message={error.message} onRetry={retry} /> : <ThesisDetailSkeleton />;
  const thesis = data.thesis;
  const live = thesis.status === 'published' || thesis.status === 'resolved';

  return (
    <article
      className={cn(
        'grid gap-x-12 gap-y-8',
        live && 'lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]',
      )}
    >
      <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
        <AuthorStatus thesis={thesis} />
        <Header thesis={thesis} mounted={mounted} />
      </div>

      {live && (
        // Pinned while scrolling only where the screen is tall enough to show all of the card.
        <aside className="lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start lg:[@media(min-height:800px)]:sticky">
          <PositionCard thesis={thesis} now={now} />
        </aside>
      )}

      <div className="min-w-0 space-y-12 lg:col-start-1 lg:row-start-2">
        {error && <LoadError message={`${error.message} Showing what was last read.`} onRetry={retry} />}

        <div className="space-y-4">
          <p className="max-w-[72ch] text-base leading-7 whitespace-pre-line">{thesis.body}</p>
          {live && (
            <div className="-ml-2 flex items-center gap-1">
              <LikeButton
                thesisId={thesis.id}
                liked={thesis.social.liked}
                likes={thesis.social.likes}
                disabled={thesis.viewerIsAuthor}
              />
              <a
                href="#comments"
                aria-label={`${thesis.social.comments} ${thesis.social.comments === 1 ? 'comment' : 'comments'}`}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground"
              >
                <MessageCircle aria-hidden className="size-[18px]" strokeWidth={1.75} />
                {thesis.social.comments}
              </a>
            </div>
          )}
        </div>

        <Sources evidence={thesis.evidence} />

        <AuditPanel audit={thesis.audit} claims={thesis.claims} model={thesis.auditModel} warning={thesis.auditWarning} />

        {live && <Comments thesisId={thesis.id} />}
      </div>
    </article>
  );
}
