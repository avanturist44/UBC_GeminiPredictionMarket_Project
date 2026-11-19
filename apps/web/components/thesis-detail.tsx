'use client';

import { Comments } from '@/components/comments';
import { LikeButton } from '@/components/like-button';
import Link from 'next/link';
import { AuditBadge, AuditPanel } from '@/components/audit';
import { CopyTrade } from '@/components/copy-trade';
import { LoadError } from '@/components/load-error';
import { AuthorLine, Result, SidePill } from '@/components/thesis-card';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, contracts, percent, timeLeft, usd } from '@/lib/format';
import { EXPLORER_ADDRESS, EXPLORER_TX, isTxHash, type ThesisDetailView, type ThesisResponse } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';

export function ThesisDetailSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-8 w-5/6" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
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

function Position({ thesis, now }: { thesis: ThesisDetailView; now: Date }) {
  const position = thesis.position;
  const left = timeLeft(thesis.market.expiryAt ? new Date(thesis.market.expiryAt) : null, now);
  if (!position || position.status === 'pending') return null;
  return (
    <section aria-labelledby="position-heading" className="space-y-2">
      <h2 id="position-heading" className="text-lg font-semibold">
        The author’s position
      </h2>
      <p className="text-sm">
        Bought {contracts(position.quantity)} {thesis.side.toUpperCase()} at {cents(thesis.entryPrice)} for{' '}
        {usd(position.costUsd)} of test money. It pays {usd(position.quantity)} if {thesis.side.toUpperCase()}{' '}
        wins and nothing if it loses.
      </p>
      <p className="text-sm text-muted-foreground">
        {thesis.status === 'resolved' ? (
          <Result thesis={thesis} />
        ) : (
          <>
            The position is locked: it cannot be sold through this app before the market resolves.{' '}
            {thesis.side.toUpperCase()} now costs {cents(thesis.currentPrice)}.{' '}
            {left.over ? 'The market has closed and awaits its result.' : thesis.market.expiryAt ? `The market closes in ${left.text}.` : ''}
          </>
        )}
      </p>
      <p className="text-sm text-muted-foreground">Simulated fill at Gemini’s live price, with no fees.</p>
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
  const tips = Number(thesis.tipsUsdc);

  return (
    <article className="space-y-6">
      <AuthorStatus thesis={thesis} />

      <header className="space-y-2">
        <AuthorLine author={thesis.author} />
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/markets/${encodeURIComponent(thesis.market.symbol)}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {thesis.market.title}
          </Link>
          {thesis.market.contractLabel && `, ${thesis.market.contractLabel}`}
        </p>
        <h1 className="text-2xl leading-tight font-medium">{thesis.headline}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <SidePill side={thesis.side} />
          <span>
            Puts YES at <span className="font-semibold tabular-nums">{percent(thesis.probabilityYes)}</span>
          </span>
          <AuditBadge audit={thesis.audit} />
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

      {error && <LoadError message={`${error.message} Showing what was last read.`} onRetry={retry} />}

      <p className="max-w-prose whitespace-pre-line leading-relaxed">{thesis.body}</p>

      {(thesis.status === 'published' || thesis.status === 'resolved') && (
        <div className="flex flex-wrap items-start gap-3">
          <CopyTrade thesis={thesis} viewerIsAuthor={thesis.viewerIsAuthor} />
          <LikeButton
            thesisId={thesis.id}
            liked={thesis.social.liked}
            likes={thesis.social.likes}
            disabled={thesis.viewerIsAuthor}
          />
          {thesis.social.copies > 0 && (
            <span className="inline-flex h-10 items-center text-sm text-muted-foreground tabular-nums">
              {thesis.social.copies} {thesis.social.copies === 1 ? 'copy' : 'copies'}
            </span>
          )}
        </div>
      )}

      <section aria-labelledby="evidence-heading" className="space-y-2">
        <h2 id="evidence-heading" className="text-lg font-semibold">
          Sources the author gave
        </h2>
        <ul className="space-y-1.5 text-sm">
          {thesis.evidence.map((item, index) => (
            <li key={index}>
              {item.claim}{' '}
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer nofollow"
                className="break-all text-primary underline-offset-4 hover:underline"
              >
                {new URL(item.url).hostname.replace(/^www\./, '')}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <AuditPanel audit={thesis.audit} claims={thesis.claims} model={thesis.auditModel} warning={thesis.auditWarning} />

      <Position thesis={thesis} now={now} />

      <section aria-labelledby="record-heading" className="space-y-2">
        <h2 id="record-heading" className="text-lg font-semibold">
          Tips and proof
        </h2>
        <p className="text-sm">
          {tips > 0
            ? `${tips.toFixed(2)} test USDC in tips is held in escrow for this thesis. It goes to the author only if the thesis is right.`
            : 'No tips are held for this thesis.'}
        </p>
        <dl className="space-y-1 text-sm">
          <div>
            <dt className="inline text-muted-foreground">Content hash: </dt>
            <dd className="inline break-all font-mono text-xs">{thesis.contentHash ?? 'none'}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">On-chain id: </dt>
            <dd className="inline break-all font-mono text-xs">{thesis.onchainId}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Registration: </dt>
            <dd className="inline">
              {isTxHash(thesis.registerTx) ? (
                <a
                  href={EXPLORER_TX + thesis.registerTx}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  recorded on Arc testnet
                </a>
              ) : thesis.registerTx ? (
                'recorded on Arc testnet'
              ) : (
                'not recorded on-chain'
              )}
              {thesis.escrowAddress && (
                <>
                  {' '}
                  in the{' '}
                  <a
                    href={EXPLORER_ADDRESS + thesis.escrowAddress}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    escrow contract
                  </a>
                </>
              )}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          The hash is computed from the market, side, probability, headline, body and sources. A
          thesis cannot be edited or deleted after it is published.
        </p>
      </section>

      {(thesis.status === 'published' || thesis.status === 'resolved') && <Comments thesisId={thesis.id} />}
    </article>
  );
}
