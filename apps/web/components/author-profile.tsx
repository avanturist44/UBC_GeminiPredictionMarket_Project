'use client';

import Link from 'next/link';
import { KindTag } from '@/components/leaderboard';
import { LoadError } from '@/components/load-error';
import { ThesisCard } from '@/components/thesis-card';
import { Skeleton } from '@/components/ui/skeleton';
import { usd } from '@/lib/format';
import { EARLY_SAMPLE, signedUsd, type AuthorResponse, type AuthorView } from '@/lib/record-view';
import type { ThesisCardView } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'yes' | 'no' }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'yes' && 'text-yes',
          tone === 'no' && 'text-no',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function AgentToday({ author }: { author: AuthorView }) {
  const status = author.agentStatus;
  if (!status) return null;
  const pnl = Number(status.realizedPnlTodayUsd);
  return (
    <section aria-labelledby="limits-heading" className="space-y-3">
      <h2 id="limits-heading" className="text-lg font-semibold">
        Limits this agent trades within
      </h2>
      {status.halted ? (
        <p role="status" className="rounded-lg border border-no p-3 text-sm font-medium text-no">
          Halted: {status.haltReason ?? 'stopped'}. It places no trades until the next UTC day.
        </p>
      ) : (
        <p className="text-sm">
          Today (UTC): {status.tradesToday} {status.tradesToday === 1 ? 'trade' : 'trades'},{' '}
          {signedUsd(pnl)} realized, {usd(status.openExposureUsd)} in open positions.
        </p>
      )}
      <dl className="divide-y border-y text-sm">
        {author.limits.map((limit) => (
          <div key={limit.label} className="flex justify-between gap-4 py-2">
            <dt className="text-muted-foreground">{limit.label}</dt>
            <dd className="text-right font-medium tabular-nums">{limit.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        The limits are checked in code before every order. The agent cannot change them.
      </p>
    </section>
  );
}

function ThesisList({ heading, theses, now, empty }: { heading: string; theses: ThesisCardView[]; now: Date; empty: string }) {
  const id = `${heading.toLowerCase().replace(/\s+/g, '-')}-heading`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-lg font-semibold">
        {heading} ({theses.length})
      </h2>
      {theses.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y border-y">
          {theses.map((thesis) => (
            <li key={thesis.id}>
              <ThesisCard thesis={thesis} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AuthorProfile({ id, initial }: { id: string; initial: AuthorResponse | undefined }) {
  const { data, error, retry } = useLive<AuthorResponse>(`/api/authors/${id}`, initial, 10_000);
  const { now } = useNow(initial?.asOf);

  if (!data) {
    return error ? (
      <LoadError message={error.message} onRetry={retry} />
    ) : (
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { author, theses } = data;
  const { record } = author;
  const profit = Number(author.profitUsd);
  const open = theses.filter((thesis) => thesis.status !== 'resolved');
  const resolved = theses.filter((thesis) => thesis.status === 'resolved');

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href="/leaderboard" className="text-sm text-primary underline-offset-4 hover:underline">
          Leaderboard
        </Link>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          {author.name} <KindTag kind={author.kind} />
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {author.kind === 'agent'
            ? (author.strategySummary ?? 'An AI agent that trades Gemini Prediction Markets and publishes a thesis with every trade.')
            : 'A person who writes theses here. Each one is backed by their own position, taken before it was published.'}
        </p>
      </header>

      {error && <LoadError message={`${error.message} Showing the last record read.`} onRetry={retry} />}

      <section aria-label="Record" className="space-y-2">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="Right" value={record.resolved === 0 ? '–' : `${record.right} of ${record.resolved}`} />
          <Stat label="Brier score" value={record.brier === null ? '–' : record.brier.toFixed(2)} />
          <Stat
            label="Profit"
            value={signedUsd(profit)}
            tone={profit > 0.004 ? 'yes' : profit < -0.004 ? 'no' : undefined}
          />
          <Stat label="Theses" value={String(author.theses)} />
        </dl>
        <p className="text-sm text-muted-foreground">
          {record.resolved === 0
            ? 'Nothing has resolved yet, so there is no record to judge.'
            : `${record.marketBrier === null ? '' : `On the same theses the market price scored ${record.marketBrier.toFixed(2)}; lower is better, and a coin flip scores 0.25. `}${
                record.resolved < EARLY_SAMPLE
                  ? `Early sample: ${record.resolved} resolved ${record.resolved === 1 ? 'thesis says' : 'theses say'} little about the future.`
                  : ''
              }`}
        </p>
      </section>

      {author.kind === 'agent' && <AgentToday author={author} />}

      <ThesisList heading="Open theses" theses={open} now={now} empty="No open theses right now." />
      <ThesisList heading="Resolved theses" theses={resolved} now={now} empty="None have resolved yet." />
    </div>
  );
}
