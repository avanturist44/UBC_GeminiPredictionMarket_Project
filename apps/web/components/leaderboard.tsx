'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Avatar } from '@/components/avatar';
import { InfoTip } from '@/components/info-tip';
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

const SORTS: Array<{ value: LeaderboardSort; label: string }> = [
  { value: 'brier', label: 'Forecast accuracy' },
  { value: 'profit', label: 'Profit' },
];

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A right-aligned column heading with its explanation behind an info icon. */
function NumberHeading({
  label,
  tip,
  active,
  className,
}: {
  label: string;
  tip: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <th scope="col" className={cn('h-11 text-right font-normal', active && 'text-foreground', className)}>
      <span className="inline-flex items-center justify-end gap-0.5">
        <InfoTip label={`About ${label}`}>{tip}</InfoTip>
        {label}
      </span>
    </th>
  );
}

function LeaderboardSkeleton() {
  return (
    <div aria-hidden className="mt-4 border-t">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 border-b sm:h-16">
          <Skeleton className="size-8 rounded-full sm:size-10" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

export function Leaderboard({ initial }: { initial: LeaderboardResponse | undefined }) {
  const { data, error, retry } = useLive<LeaderboardResponse>('/api/leaderboard', initial, 10_000);
  const [sort, setSort] = useState<LeaderboardSort>('brier');

  if (!data) {
    return error ? (
      <div className="mt-6">
        <LoadError message={error.message} onRetry={retry} />
      </div>
    ) : (
      <LeaderboardSkeleton />
    );
  }

  if (data.authors.length === 0) {
    return (
      <p className="mt-6 rounded-lg border p-4 text-sm">
        Nobody has published a thesis yet, so there is nothing to rank.{' '}
        <Link href="/write" className="text-primary underline-offset-4 hover:underline">
          Write the first one
        </Link>
      </p>
    );
  }

  const ranked = rankAuthors(data.authors, sort);
  const resolved = data.authors.reduce((sum, author) => sum + author.record.resolved, 0);
  const early = resolved < EARLY_SAMPLE * data.authors.length;

  return (
    <div className="mt-5 lg:mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Rank by" className="inline-flex rounded-lg border p-0.5">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              aria-pressed={sort === option.value}
              className={cn(
                'h-8 rounded-md px-3 text-sm transition-colors',
                sort === option.value
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {early && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            Early sample
            <InfoTip label="About the early sample">
              These ranks rest on {plural(resolved, 'resolved thesis', 'resolved theses')} across{' '}
              {plural(data.authors.length, 'author', 'authors')}. A few markets say little about who forecasts
              well, so expect the order to change.
            </InfoTip>
          </p>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <LoadError message={`${error.message} Showing the last ranking read.`} onRetry={retry} />
        </div>
      )}

      <table className="mt-4 w-full table-fixed text-sm sm:text-[15px] lg:text-base">
        <thead className="text-sm text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="h-11 w-6 sm:w-10 lg:w-12">
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className="h-11 text-left font-normal">
              {/* The same box as the headings with an info icon, so all labels share a line. */}
              <span className="inline-flex h-6 items-center">Author</span>
            </th>
            <NumberHeading
              label="Brier"
              active={sort === 'brier'}
              className="w-16 sm:w-24"
              tip={
                <>
                  How close an author&apos;s probabilities came to what happened: the average squared gap. Lower is
                  better. A perfect record scores 0 and a coin flip scores 0.25.
                </>
              }
            />
            <NumberHeading
              label="Market"
              className="hidden sm:table-cell sm:w-24 lg:w-28"
              tip={
                <>
                  The market price&apos;s own Brier score on the same theses, from the price when each was
                  published. An author with a lower score called it better than the market did.
                </>
              }
            />
            <NumberHeading
              label="Right"
              className="w-16 sm:w-24"
              tip={<>Resolved theses whose side won, out of all the author&apos;s resolved theses.</>}
            />
            <NumberHeading
              label="Profit"
              active={sort === 'profit'}
              className="w-[68px] sm:w-28 lg:w-32"
              tip={<>What the author&apos;s own positions paid, less what they cost, in test dollars.</>}
            />
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {ranked.map((author, index) => {
            const profit = Number(author.profitUsd);
            const { brier, marketBrier, right } = author.record;
            return (
              <tr
                key={author.id}
                className="relative border-b transition-colors hover:bg-secondary/40 has-[a:focus-visible]:bg-secondary/40 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring"
              >
                <td className="py-3 text-muted-foreground">{index + 1}</td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-2.5 sm:gap-3">
                    <Avatar name={author.name} kind={author.kind} className="size-8 text-xs sm:size-10 sm:text-sm" />
                    <div className="min-w-0">
                      {/* The link covers the whole row, so the row is the target. */}
                      <Link
                        href={`/authors/${author.id}`}
                        className="block truncate font-medium outline-none after:absolute after:inset-0"
                      >
                        {author.name}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground sm:text-[13px]">
                        <KindTag kind={author.kind} />
                        {/* Too long for a phone row; the Right column carries the resolved count there. */}
                        <span className="hidden truncate sm:inline">
                          {plural(author.theses, 'thesis', 'theses')}, {author.record.resolved} resolved
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className={cn('py-3 text-right', sort === 'brier' && 'font-medium')}>
                  {brier === null ? <span className="text-muted-foreground">–</span> : brier.toFixed(2)}
                </td>
                <td className="hidden py-3 text-right text-muted-foreground sm:table-cell">
                  {marketBrier === null ? '–' : marketBrier.toFixed(2)}
                </td>
                <td className="py-3 text-right whitespace-nowrap">
                  {author.record.resolved === 0 ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    `${right} of ${author.record.resolved}`
                  )}
                </td>
                <td
                  className={cn(
                    'py-3 text-right whitespace-nowrap',
                    sort === 'profit' && 'font-medium',
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
    </div>
  );
}
