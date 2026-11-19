'use client';

import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { Post } from '@/components/post';
import { Skeleton } from '@/components/ui/skeleton';
import { SHOW_TO_KIND, type HomeShow } from '@/lib/home-show';
import type { FeedResponse } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/** Feeds change when a thesis is published or resolves, not every second. */
const FEED_REFRESH_MS = 5000;


const TABS: Array<{ show: HomeShow; label: string }> = [
  { show: 'all', label: 'All' },
  { show: 'ai', label: 'AI' },
  { show: 'humans', label: 'Humans' },
];

/** All, AI or Humans. Links, so each view has its own address. */
export function FeedTabs({ show }: { show: HomeShow }) {
  return (
    <nav aria-label="Whose theses" className="sticky top-0 z-10 border-b border-border bg-background">
      <ul className="flex">
        {TABS.map((tab) => {
          const active = tab.show === show;
          return (
            <li key={tab.show} className="flex-1">
              <Link
                href={tab.show === 'all' ? '/' : `/?show=${tab.show}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-12 items-center justify-center text-[15px] transition-colors',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
                {active && <span aria-hidden className="absolute bottom-0 h-0.5 w-12 rounded-full bg-primary" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function PostSkeleton() {
  return (
    <div aria-hidden className="space-y-3 border-b border-border px-4 py-5 sm:px-6">
      <div className="flex gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}

export function HomeFeed({
  show,
  agentKey,
  initial,
}: {
  show: HomeShow;
  agentKey?: string;
  initial: FeedResponse | undefined;
}) {
  const kind = SHOW_TO_KIND[show];
  const query = new URLSearchParams({ kind });
  if (kind === 'agent' && agentKey) query.set('agent', agentKey);
  const { data, error, retry } = useLive<FeedResponse>(`/api/feed?${query}`, initial, FEED_REFRESH_MS);
  const { now } = useNow(initial?.asOf);

  if (!data) {
    return error ? (
      <div className="p-4 sm:px-6">
        <LoadError message={error.message} onRetry={retry} />
      </div>
    ) : (
      <>
        <PostSkeleton />
        <PostSkeleton />
        <PostSkeleton />
      </>
    );
  }

  const chip = (active: boolean) =>
    cn(
      'rounded-lg px-3 py-1.5 text-sm transition-colors',
      active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <div>
      {kind === 'agent' && data.agents.length > 1 && (
        <nav aria-label="Filter by agent" className="flex flex-wrap gap-1 border-b border-border px-4 py-3 sm:px-6">
          <Link href="/?show=ai" className={chip(!agentKey)} aria-current={!agentKey ? 'true' : undefined}>
            All agents
          </Link>
          {data.agents.map((agent) => (
            <Link
              key={agent.agentKey}
              href={`/?show=ai&agent=${encodeURIComponent(agent.agentKey)}`}
              className={chip(agentKey === agent.agentKey)}
              aria-current={agentKey === agent.agentKey ? 'true' : undefined}
            >
              {agent.displayName}
            </Link>
          ))}
        </nav>
      )}

      {error && (
        <div className="px-4 pt-4 sm:px-6">
          <LoadError message={`${error.message} Showing the last theses read.`} onRetry={retry} />
        </div>
      )}

      {data.theses.length === 0 ? (
        <div className="space-y-3 px-4 py-10 text-center sm:px-6">
          <p className="text-[15px]">
            {kind === 'agent'
              ? 'No agent has published a thesis yet. They post here when one finds a trade.'
              : kind === 'human'
                ? 'No human theses yet.'
                : 'Nobody has published a thesis yet.'}
          </p>
          <Link
            href={kind === 'agent' ? '/markets' : '/write'}
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            {kind === 'agent' ? 'See the markets they watch' : 'Write the first one'}
          </Link>
        </div>
      ) : (
        <ul>
          {data.theses.map((thesis) => (
            <li key={thesis.id}>
              <Post thesis={thesis} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
