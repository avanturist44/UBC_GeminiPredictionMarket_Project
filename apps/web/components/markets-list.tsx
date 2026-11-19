'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, noBuyPrice, timeLeft } from '@/lib/format';
import {
  marketTopics,
  marketsInTopic,
  sortMarkets,
  type MarketSort,
  type MarketTopic,
  type MarketView,
  type MarketsResponse,
} from '@/lib/market-view';
import { withLiveQuote } from '@/lib/live-quote';
import { useLive, useNow } from '@/lib/use-live';
import { useLiveQuotes } from '@/lib/use-live-quotes';
import { cn } from '@/lib/utils';

const SORTS: Array<{ value: MarketSort; label: string }> = [
  { value: 'expiry', label: 'Closing soonest' },
  { value: 'theses', label: 'Most theses' },
];

export function MarketsListSkeleton() {
  return (
    <ul aria-hidden className="divide-y border-y">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 py-4">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="row-span-2 h-11 w-24" />
          <Skeleton className="h-4 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

function ThesisCounts({ market }: { market: MarketView }) {
  if (market.thesesYes + market.thesesNo === 0) {
    return <span className="text-muted-foreground">No theses yet</span>;
  }
  return (
    <span>
      <span className="font-medium text-yes">{market.thesesYes} for YES</span>
      <span className="text-muted-foreground">, </span>
      <span className="font-medium text-no">{market.thesesNo} for NO</span>
    </span>
  );
}

/** What one contract of a side costs to buy right now. This is the figure Gemini's site shows. */
function BuyPrice({ side, price }: { side: 'yes' | 'no'; price: string | number | null }) {
  return (
    <span className="flex flex-col items-end">
      <span className={cn('text-xs font-medium', side === 'yes' ? 'text-yes' : 'text-no')}>
        {side === 'yes' ? 'Yes' : 'No'}
      </span>
      <span className="text-xl font-semibold">{cents(price)}</span>
    </span>
  );
}

function MarketRowLink({ market, now }: { market: MarketView; now: Date }) {
  const left = timeLeft(market.expiryAt ? new Date(market.expiryAt) : null, now);
  const tradable = market.marketState === 'open' && !left.over;
  return (
    <Link
      href={`/markets/${encodeURIComponent(market.symbol)}`}
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-4 hover:bg-muted/60 sm:-mx-3 sm:rounded-lg sm:px-3"
    >
      <span className="font-medium leading-snug">
        {market.title}
        {market.contractLabel && (
          <span className="block font-normal text-muted-foreground">{market.contractLabel}</span>
        )}
      </span>
      <span className="row-span-2 flex gap-4 self-start text-right tabular-nums">
        <BuyPrice side="yes" price={market.yesAsk} />
        <BuyPrice side="no" price={noBuyPrice(market.yesBid)} />
      </span>

      <span className="text-sm text-muted-foreground">
        {left.over ? (
          'Closed'
        ) : market.expiryAt === null ? (
          left.text
        ) : (
          <>
            Closes in{' '}
            <span className="tabular-nums">{left.text}</span>
          </>
        )}
        {!tradable && !left.over && ' (trading paused)'}
      </span>

      <span className="col-span-2 text-sm">
        <ThesisCounts market={market} />
      </span>
    </Link>
  );
}

/**
 * One chip per topic, with how many markets it holds. On a phone the row scrolls sideways
 * instead of wrapping, so the list starts at the same height whichever topic is chosen.
 */
function TopicBar({
  topics,
  total,
  active,
  onChoose,
}: {
  topics: MarketTopic[];
  total: number;
  active: string;
  onChoose: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Topics"
      className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
        {[{ id: 'all', label: 'All', count: total }, ...topics].map((topic) => {
          const selected = topic.id === active;
          return (
            <li key={topic.id}>
              <button
                type="button"
                onClick={() => onChoose(topic.id)}
                aria-pressed={selected}
                className={cn(
                  'flex h-9 items-center gap-2 rounded-lg border px-3 text-sm whitespace-nowrap transition-colors',
                  selected
                    ? 'border-input bg-secondary font-medium text-foreground'
                    : 'border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {topic.label}
                <span className="text-xs tabular-nums text-muted-foreground">{topic.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function MarketsList({
  initial,
  initialTopic = 'all',
}: {
  initial: MarketsResponse | undefined;
  /** From the address, so a link to one topic opens on it. */
  initialTopic?: string;
}) {
  const { data, error, retry } = useLive<MarketsResponse>('/api/markets', initial);
  const { now } = useNow(initial?.asOf);
  const [sort, setSort] = useState<MarketSort>('expiry');
  const [topic, setTopic] = useState(initialTopic);

  /** Filters in place and keeps the address in step, without reloading the page. */
  function chooseTopic(id: string) {
    setTopic(id);
    const url = new URL(window.location.href);
    if (id === 'all') url.searchParams.delete('topic');
    else url.searchParams.set('topic', id);
    window.history.replaceState(null, '', url);
  }
  // Prices come live from Gemini while the page's own connection is up, and from our API
  // (re-read every two seconds) whenever it is not.
  const live = useLiveQuotes(data?.markets.map((market) => market.symbol) ?? []);

  if (!data) {
    return error ? <LoadError message={error.message} onRetry={retry} /> : <MarketsListSkeleton />;
  }

  if (data.markets.length === 0) {
    return (
      <p className="rounded-lg border p-4 text-sm">
        No markets are being tracked yet. They appear here within a minute of the price recorder
        starting.
      </p>
    );
  }

  const topics = marketTopics(data.markets);
  const current = topics.find((t) => t.id === topic);
  const shown = marketsInTopic(data.markets, topic);

  return (
    <div className="space-y-4">
      <TopicBar topics={topics} total={data.markets.length} active={topic} onChoose={chooseTopic} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
          {shown.length} {shown.length === 1 ? 'market' : 'markets'}
          {current ? ` in ${current.label}` : ''}
        </p>
        {/* ml-auto keeps the sort on the right even when it wraps under the count. */}
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Sort markets">
          {SORTS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={sort === option.value ? 'secondary' : 'ghost'}
              className={sort === option.value ? undefined : 'text-muted-foreground'}
              aria-pressed={sort === option.value}
              onClick={() => setSort(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {error && <LoadError message={`${error.message} Showing the last prices read.`} onRetry={retry} />}

      {shown.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-border p-4 text-sm">
          <p>No open markets in this topic right now. Markets come and go as Gemini lists and settles them.</p>
          <Button variant="secondary" size="sm" onClick={() => chooseTopic('all')}>
            Show all markets
          </Button>
        </div>
      ) : (
        <ul className="divide-y border-y">
          {sortMarkets(shown, sort).map((market) => (
            <li key={market.symbol}>
              <MarketRowLink market={withLiveQuote(market, live.quoteFor(market.symbol))} now={now} />
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-muted-foreground">
        {live.connected
          ? 'Prices are live from Gemini Prediction Markets'
          : 'Prices from Gemini Prediction Markets, refreshed every 2 seconds'}
        : what one contract of each side costs to buy right now. A contract pays $1 if its side
        wins. A dash means nobody is selling that side.
      </p>
    </div>
  );
}
