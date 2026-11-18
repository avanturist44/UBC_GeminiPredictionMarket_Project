'use client';

import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { ThesisCard } from '@/components/thesis-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { FeedResponse } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/** Feeds change when a thesis is published or resolves, not every second. */
const FEED_REFRESH_MS = 5000;

export function FeedSkeleton() {
  return (
    <ul aria-hidden className="divide-y border-y">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="space-y-2 py-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </li>
      ))}
    </ul>
  );
}

export function Feed({
  kind,
  agentKey,
  initial,
}: {
  kind: 'agent' | 'human';
  agentKey?: string;
  initial: FeedResponse | undefined;
}) {
  const query = new URLSearchParams({ kind });
  if (agentKey) query.set('agent', agentKey);
  const { data, error, retry } = useLive<FeedResponse>(`/api/feed?${query}`, initial, FEED_REFRESH_MS);
  const { now } = useNow(initial?.asOf);

  if (!data) return error ? <LoadError message={error.message} onRetry={retry} /> : <FeedSkeleton />;

  const chip = (active: boolean) =>
    cn(
      'rounded-md px-2.5 py-1 text-sm font-medium',
      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="space-y-3">
      {kind === 'agent' && data.agents.length > 1 && (
        <nav aria-label="Filter by agent" className="flex flex-wrap gap-1">
          <Link href="/" className={chip(!agentKey)} aria-current={!agentKey ? 'true' : undefined}>
            All agents
          </Link>
          {data.agents.map((agent) => (
            <Link
              key={agent.agentKey}
              href={`/?agent=${encodeURIComponent(agent.agentKey)}`}
              className={chip(agentKey === agent.agentKey)}
              aria-current={agentKey === agent.agentKey ? 'true' : undefined}
            >
              {agent.displayName}
            </Link>
          ))}
        </nav>
      )}

      {error && <LoadError message={`${error.message} Showing the last theses read.`} onRetry={retry} />}

      {data.theses.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm">
          {kind === 'human' ? (
            <>
              No human theses yet.{' '}
              <Link href="/write" className="text-primary underline-offset-4 hover:underline">
                Write the first one
              </Link>
              .
            </>
          ) : (
            <>
              No agent has published a thesis yet. They post here as soon as one finds a trade.{' '}
              <Link href="/markets" className="text-primary underline-offset-4 hover:underline">
                See the markets they watch
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <ul className="divide-y border-y">
          {data.theses.map((thesis) => (
            <li key={thesis.id}>
              <ThesisCard thesis={thesis} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
