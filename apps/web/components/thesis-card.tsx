import Link from 'next/link';
import { AuditBadge } from '@/components/audit';
import { cents, percent, timeLeft, usd } from '@/lib/format';
import { recordText, type ThesisCardView } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

export function SidePill({ side }: { side: 'yes' | 'no' }) {
  return (
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-xs font-semibold text-white',
        side === 'yes' ? 'bg-yes' : 'bg-no',
      )}
    >
      {side.toUpperCase()}
    </span>
  );
}

/** `linked` is off where the author has no profile to open, as in the editor's preview. */
export function AuthorLine({ author, linked = true }: { author: ThesisCardView['author']; linked?: boolean }) {
  return (
    <p className="text-sm">
      {linked ? (
        <Link href={`/authors/${author.id}`} className="font-medium underline-offset-4 hover:underline">
          {author.name}
        </Link>
      ) : (
        <span className="font-medium">{author.name}</span>
      )}{' '}
      <span
        className={cn(
          'rounded border px-1 py-px text-xs font-medium',
          author.kind === 'agent' ? 'border-primary text-primary' : 'text-muted-foreground',
        )}
      >
        {author.kind === 'agent' ? 'AI' : 'Human'}
      </span>{' '}
      <span className="text-muted-foreground">{recordText(author.record)}</span>
    </p>
  );
}

/** What became of a resolved thesis: right or wrong, and what its author's position paid. */
export function Result({ thesis }: { thesis: ThesisCardView }) {
  if (thesis.status !== 'resolved' || !thesis.outcome) return null;
  if (thesis.outcome === 'void') return <span className="font-medium">Market voided, stake returned</span>;
  const position = thesis.position;
  return (
    <span className={cn('font-medium', thesis.outcome === 'right' ? 'text-yes' : 'text-no')}>
      {thesis.outcome === 'right' ? 'Right' : 'Wrong'}
      {position?.payoutUsd != null ? `: paid ${usd(position.payoutUsd)} on ${usd(position.costUsd)}` : ''}
    </span>
  );
}

/**
 * One thesis in a feed. `linked` is off for the editor's preview, where the thesis does not
 * exist yet and has nowhere to link to.
 */
export function ThesisCard({
  thesis,
  now,
  linked = true,
}: {
  thesis: ThesisCardView;
  now: Date;
  linked?: boolean;
}) {
  const left = timeLeft(thesis.market.expiryAt ? new Date(thesis.market.expiryAt) : null, now);
  const tips = Number(thesis.tipsUsdc);
  const headline = <span className="font-medium leading-snug">{thesis.headline}</span>;
  return (
    <article className="space-y-2 py-4">
      <AuthorLine author={thesis.author} linked={linked} />
      <p className="text-sm text-muted-foreground">
        {linked ? (
          <Link
            href={`/markets/${encodeURIComponent(thesis.market.symbol)}`}
            className="underline-offset-4 hover:underline"
          >
            {thesis.market.title}
          </Link>
        ) : (
          thesis.market.title
        )}
        {thesis.market.contractLabel && `, ${thesis.market.contractLabel}`}
      </p>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
          <SidePill side={thesis.side} />
          <span className="text-sm font-semibold tabular-nums" title="The author's probability of YES">
            {percent(thesis.probabilityYes)}
          </span>
        </span>
        {linked ? (
          <Link href={`/thesis/${thesis.id}`} className="underline-offset-4 hover:underline">
            {headline}
          </Link>
        ) : (
          headline
        )}
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">{thesis.body}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <AuditBadge audit={thesis.audit} />
        {thesis.status === 'resolved' ? (
          <Result thesis={thesis} />
        ) : (
          <>
            <span className="tabular-nums text-muted-foreground">
              Bought at {cents(thesis.entryPrice)}, now {cents(thesis.currentPrice)}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {left.over
                ? 'Closed, awaiting result'
                : thesis.market.expiryAt
                  ? `Closes in ${left.text}`
                  : left.text}
            </span>
          </>
        )}
        {tips > 0 && <span className="tabular-nums text-muted-foreground">{tips.toFixed(2)} USDC in tips</span>}
      </div>
    </article>
  );
}
