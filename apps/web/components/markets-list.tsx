'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, noBuyPrice, timeLeft } from '@/lib/format';
import { sortMarkets, type MarketSort, type MarketView, type MarketsResponse } from '@/lib/market-view';
import { useLive, useNow } from '@/lib/use-live';
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

export function MarketsList({ initial }: { initial: MarketsResponse | undefined }) {
  const { data, error, retry } = useLive<MarketsResponse>('/api/markets', initial);
  const { now } = useNow(initial?.asOf);
  const [sort, setSort] = useState<MarketSort>('expiry');

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sort markets">
        {SORTS.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={sort === option.value ? 'secondary' : 'ghost'}
            aria-pressed={sort === option.value}
            onClick={() => setSort(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {error && <LoadError message={`${error.message} Showing the last prices read.`} onRetry={retry} />}

      <ul className="divide-y border-y">
        {sortMarkets(data.markets, sort).map((market) => (
          <li key={market.symbol}>
            <MarketRowLink market={market} now={now} />
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted-foreground">
        Live prices from Gemini Prediction Markets: what one contract of each side costs to buy
        right now. A contract pays $1 if its side wins. A dash means nobody is selling that side.
      </p>
    </div>
  );
}
