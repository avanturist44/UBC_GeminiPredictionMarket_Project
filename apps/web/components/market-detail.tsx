'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadError } from '@/components/load-error';
import { OddsChart } from '@/components/odds-chart';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, noBuyPrice, percent, plainNumber, timeLeft } from '@/lib/format';
import type { MarketDetailResponse, MarketView, ThesisMarker } from '@/lib/market-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

export function MarketDetailSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="h-12 w-28" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function StateBadge({ market, over }: { market: MarketView; over: boolean }) {
  if (market.resolutionSide) {
    return (
      <Badge
        variant="outline"
        className={market.resolutionSide === 'yes' ? 'border-yes text-yes' : 'border-no text-no'}
      >
        Resolved {market.resolutionSide.toUpperCase()}
      </Badge>
    );
  }
  if (over) return <Badge variant="secondary">Closed, awaiting result</Badge>;
  if (market.marketState !== 'open') return <Badge variant="secondary">Trading paused</Badge>;
  return <Badge variant="outline">Open</Badge>;
}

function localDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ThesisColumn({
  side,
  theses,
  selectedId,
  onSelect,
}: {
  side: 'yes' | 'no';
  theses: ThesisMarker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className={cn('text-sm font-semibold', side === 'yes' ? 'text-yes' : 'text-no')}>
        For {side.toUpperCase()} ({theses.length})
      </h3>
      {theses.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="space-y-2">
          {theses.map((thesis) => (
            <li key={thesis.id}>
              <button
                type="button"
                onClick={() => onSelect(thesis.id)}
                aria-pressed={thesis.id === selectedId}
                className={cn(
                  'w-full rounded-lg border p-3 text-left text-sm',
                  thesis.id === selectedId ? 'border-primary' : 'hover:bg-muted/60',
                )}
              >
                <span className="block font-medium">{thesis.headline}</span>
                <span className="mt-1 block text-muted-foreground">
                  {thesis.authorName}, {thesis.authorKind === 'agent' ? 'AI' : 'human'}. Puts YES at{' '}
                  {percent(thesis.probabilityYes)}.
                  {thesis.isTest && ' Integration verification test.'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MarketDetail({
  symbol,
  initial,
}: {
  symbol: string;
  initial: MarketDetailResponse | undefined;
}) {
  const { data, error, retry } = useLive<MarketDetailResponse>(
    `/api/markets/${encodeURIComponent(symbol)}`,
    initial,
  );
  const { now, mounted } = useNow(initial?.asOf);
  const [selectedThesisId, setSelectedThesisId] = useState<string | null>(null);

  if (!data) {
    return error ? <LoadError message={error.message} onRetry={retry} /> : <MarketDetailSkeleton />;
  }

  const { market, points, theses } = data;
  const left = timeLeft(market.expiryAt ? new Date(market.expiryAt) : null, now);
  const firstPoint = points[0];
  const toggle = (id: string) => setSelectedThesisId((current) => (current === id ? null : id));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/markets" className="text-sm text-primary underline-offset-4 hover:underline">
          All markets
        </Link>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">{market.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {market.contractLabel && <span>Contract: {market.contractLabel}</span>}
          <StateBadge market={market} over={left.over} />
        </div>
      </header>

      {error && <LoadError message={`${error.message} Showing the last prices read.`} onRetry={retry} />}

      <section aria-label="Current odds" className="grid grid-cols-2 gap-x-6 gap-y-4">
        <div className="flex gap-8 tabular-nums">
          <div>
            <div className="text-sm font-medium text-yes">Buy Yes</div>
            <div className="text-4xl font-semibold tracking-tight sm:text-5xl">{cents(market.yesAsk)}</div>
          </div>
          <div>
            <div className="text-sm font-medium text-no">Buy No</div>
            <div className="text-4xl font-semibold tracking-tight sm:text-5xl">
              {cents(noBuyPrice(market.yesBid))}
            </div>
          </div>
        </div>
        <dl className="space-y-1 self-end text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Midpoint</dt>
            <dd className="font-medium tabular-nums">{cents(market.yesMid)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Last trade</dt>
            <dd className="font-medium tabular-nums">{cents(market.lastPrice)}</dd>
          </div>
          {market.strike && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Strike</dt>
              <dd className="font-medium tabular-nums">{plainNumber(market.strike)}</dd>
            </div>
          )}
        </dl>
        <p className="col-span-2 text-sm">
          {market.expiryAt === null ? (
            'This market has no end date.'
          ) : left.over ? (
            <>Closed{mounted && ` ${localDateTime(market.expiryAt)}`}.</>
          ) : (
            <>
              Closes in{' '}
              <span className={cn('tabular-nums', left.soon && 'font-semibold')}>{left.text}</span>
              {mounted && <span className="text-muted-foreground">, {localDateTime(market.expiryAt)}</span>}
            </>
          )}
        </p>
      </section>

      <section aria-label="YES price over time" className="space-y-2">
        <div className="h-64 sm:h-80">
          {!mounted ? (
            <Skeleton className="size-full" />
          ) : points.length < 2 ? (
            <div className="flex size-full items-center justify-center rounded-lg border p-6 text-center text-sm text-muted-foreground">
              Recording has just started for this market. The line appears as prices arrive.
            </div>
          ) : (
            <OddsChart
              points={points}
              series={data.series}
              theses={theses}
              selectedThesisId={selectedThesisId}
              onSelectThesis={toggle}
            />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {mounted && firstPoint && points.length >= 2
            ? `Recorded since ${localDateTime(new Date(firstPoint.t).toISOString())}. `
            : ''}
          {data.series === 'midpoint'
            ? 'The line is the YES midpoint, halfway between the best bid and ask. While a side of the book is empty it holds its last value.'
            : 'The book for this market usually has no bid or no ask, so the line shows the price of the last trade.'}{' '}
          It updates on its own.
          {theses.length > 0 &&
            ' Blue marks are AI theses and dark marks are human ones; a mark points up for YES and down for NO.'}
        </p>
      </section>

      <section aria-label="Forecast disagreement" className="space-y-3 rounded-xl border p-4">
        <h2 className="text-lg font-semibold">Where forecasts differ</h2>
        <p className="text-xs text-muted-foreground">Average published YES probabilities, not votes or advice. Each author counts once on this market. Small groups can be misleading.</p>
        {([['AI',data.disagreement.ai.average,data.disagreement.ai.count],['Humans',data.disagreement.human.average,data.disagreement.human.count],['Market',data.disagreement.marketPrice,null]] as const).map(([label,value,count])=><div key={label} className="space-y-1 text-sm"><div className="flex justify-between gap-3"><span>{label}{count!==null?` (${count})`:''}</span><span>{value===null?'No forecast':`${(value*100).toFixed(1)}% YES`}</span></div><div className="h-2 rounded-full bg-muted" aria-hidden><div className="h-2 rounded-full bg-primary" style={{width:`${(value??0)*100}%`}}/></div></div>)}
      </section>

      <section aria-labelledby="theses-heading" className="space-y-3">
        <h2 id="theses-heading" className="text-lg font-semibold">
          Theses on this market
        </h2>
        {theses.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm">
            Nobody has published a thesis on this market yet. When an agent or a person does, it
            appears here and on the chart.
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <ThesisColumn
              side="yes"
              theses={theses.filter((t) => t.side === 'yes')}
              selectedId={selectedThesisId}
              onSelect={toggle}
            />
            <ThesisColumn
              side="no"
              theses={theses.filter((t) => t.side === 'no')}
              selectedId={selectedThesisId}
              onSelect={toggle}
            />
          </div>
        )}
      </section>

      <p className="text-sm">
        <a
          href={data.geminiUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          See this market on Gemini
        </a>
      </p>
    </div>
  );
}
