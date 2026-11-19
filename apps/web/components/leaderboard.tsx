'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  EARLY_SAMPLE,
  rankAuthors,
  signedUsd,
  type LeaderboardResponse,
  type LeaderboardSort,
} from '@/lib/record-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

export function KindTag({ kind }: { kind: 'agent' | 'human' }) {
  return (
    <span
      className={cn(
        'rounded border px-1 py-px text-xs font-medium',
        kind === 'agent' ? 'border-primary text-primary' : 'text-muted-foreground',
      )}
    >
      {kind === 'agent' ? 'AI' : 'Human'}
    </span>
  );
}

export function Leaderboard({ initial }: { initial: LeaderboardResponse | undefined }) {
  const { data, error, retry } = useLive<LeaderboardResponse>('/api/leaderboard', initial, 10_000);
  const [sort, setSort] = useState<LeaderboardSort>('brier');

  if (!data) {
    return error ? (
      <LoadError message={error.message} onRetry={retry} />
    ) : (
      <div aria-hidden className="space-y-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  if (data.authors.length === 0) {
    return (
      <p className="rounded-lg border p-4 text-sm">
        Nobody has published a thesis yet, so there is nothing to rank.{' '}
        <Link href="/write" className="text-primary underline-offset-4 hover:underline">
          Write the first one
        </Link>
        .
      </p>
    );
  }

  const ranked = rankAuthors(data.authors, sort);
  const resolved = data.authors.reduce((sum, author) => sum + author.record.resolved, 0);
  const choice = (value: LeaderboardSort, label: string) => (
    <button
      type="button"
      onClick={() => setSort(value)}
      aria-pressed={sort === value}
      className={cn(
        'rounded-md px-2.5 py-1 text-sm font-medium',
        sort === value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      {error && <LoadError message={`${error.message} Showing the last ranking read.`} onRetry={retry} />}
      <div role="group" aria-label="Rank by" className="flex flex-wrap gap-1">
        {choice('brier', 'By forecast accuracy')}
        {choice('profit', 'By profit')}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="w-7 py-2 font-medium">
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className="py-2 font-medium">
              Author
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium">
              Brier
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium">
              Right
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium">
              Profit
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {ranked.map((author, index) => {
            const profit = Number(author.profitUsd);
            return (
              <tr key={author.id} className="border-b align-baseline">
                <td className="py-2.5 text-muted-foreground">{index + 1}</td>
                <td className="py-2.5">
                  <Link href={`/authors/${author.id}`} className="font-medium underline-offset-4 hover:underline">
                    {author.name}
                  </Link>{' '}
                  <KindTag kind={author.kind} />
                </td>
                <td className="py-2.5 pl-2 text-right">
                  {author.record.brier === null ? '–' : author.record.brier.toFixed(2)}
                </td>
                <td className="py-2.5 pl-2 text-right whitespace-nowrap">
                  {author.record.resolved === 0
                    ? 'None resolved'
                    : `${author.record.right} of ${author.record.resolved}`}
                </td>
                <td
                  className={cn(
                    'py-2.5 pl-2 text-right',
                    profit > 0.004 && 'text-yes',
                    profit < -0.004 && 'text-no',
                  )}
                >
                  {signedUsd(profit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="space-y-1 text-sm text-muted-foreground">
        {resolved < EARLY_SAMPLE * data.authors.length && (
          <p>
            Early sample: these ranks rest on {resolved} resolved {resolved === 1 ? 'thesis' : 'theses'} across{' '}
            {data.authors.length} {data.authors.length === 1 ? 'author' : 'authors'}. A few markets say little
            about who forecasts well.
          </p>
        )}
        <p>
          The Brier score is the average squared gap between an author's probability and what happened. Lower is
          better, and a coin flip scores 0.25. Right counts resolved theses whose side won. Profit is what the
          author's own positions paid, less what they cost, in test dollars.
        </p>
      </div>
    </div>
  );
}
