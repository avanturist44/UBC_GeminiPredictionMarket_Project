'use client';

import { useState } from 'react';
import { ArenaChart, ModelMark, type ArenaMode, type ArenaRange } from '@/components/arena-chart';
import { ArenaPanel } from '@/components/arena-panel';
import { LoadError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { usd } from '@/lib/format';
import { ARENA_MODELS, MODEL_BY_ID, arenaDate, signedPct, type ArenaResponse } from '@/lib/arena-view';
import { signedUsd } from '@/lib/record-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The arena: one wide chart of every model's account value, the models' standings under
 * it, and a panel beside it with their trades, reasoning, positions and the rules.
 */

const ARENA_REFRESH_MS = 5000;

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-md px-3 text-[13px] transition-colors',
            o.value === value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const changeClass = (v: number) => (v > 0.004 ? 'text-yes' : v < -0.004 ? 'text-no' : 'text-muted-foreground');

function Standings({ data }: { data: ArenaResponse }) {
  return (
    <ul className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-6" aria-label="Account value by model">
      {ARENA_MODELS.map((m) => {
        const s = data.standings.find((x) => x.id === m.id)!;
        return (
          <li key={m.id} className="min-w-0 space-y-2 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <ModelMark id={m.id} size={20} />
              <span className="line-clamp-2 text-[12px] leading-tight">{m.name}</span>
            </div>
            <p className="text-[17px] font-medium tabular-nums">{usd(s.valueUsd)}</p>
            <p className={cn('text-[12px] tabular-nums', changeClass(s.changeUsd))}>
              {signedUsd(s.changeUsd)}, {signedPct(s.changePct)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function ArenaDetail({ initial }: { initial: ArenaResponse | undefined }) {
  const { data, error, retry } = useLive<ArenaResponse>('/api/arena', initial, ARENA_REFRESH_MS);
  const [mode, setMode] = useState<ArenaMode>('usd');
  const [range, setRange] = useState<ArenaRange>('all');

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-4 pt-6 sm:px-6 lg:px-8">
        {error ? <LoadError message={error.message} onRetry={retry} /> : <Skeleton className="h-[60vh] w-full" />}
      </div>
    );
  }

  const m = data.matchup;
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pt-6 pb-8 sm:px-6 lg:px-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="@container min-w-0 space-y-4">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-[22px] leading-tight font-medium">Model arena</h1>
              <p className="text-sm text-muted-foreground">
                {ARENA_MODELS.length} models, {usd(data.bankrollUsd)} of test money each, since {arenaDate(data.since)}
                {data.sample && <span className="text-foreground">. Sample data</span>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Segmented
                label="Show values as"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'usd', label: '$' },
                  { value: 'pct', label: '%' },
                ]}
              />
              <Segmented
                label="Time range"
                value={range}
                onChange={setRange}
                options={[
                  { value: 'all', label: 'All' },
                  { value: '72h', label: '72h' },
                ]}
              />
            </div>
          </header>

          {m && (
            <p className="text-[15px] leading-relaxed">
              {m.headline}
              {m.deal && <> on {m.deal}</>}.{' '}
              <span className="text-muted-foreground">
                {MODEL_BY_ID[m.leader].name} is ahead by <span className="text-primary tabular-nums">{usd(m.gapUsd)}</span>.
              </span>
            </p>
          )}

          <figure className="space-y-2 rounded-xl border border-border bg-card p-4">
            <figcaption className="text-sm font-medium">Total account value</figcaption>
            <div className="h-80 lg:h-[60vh] lg:max-h-[680px] lg:min-h-[400px]">
              {data.points.length > 0 ? (
                <ArenaChart data={data} mode={mode} range={range} variant="full" />
              ) : (
                <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                  No model has opened a position yet. Each line starts at the first one.
                </p>
              )}
            </div>
          </figure>

          {error && <LoadError message={error.message} onRetry={retry} />}

          <Standings data={data} />
        </div>

        {/* On wide screens the panel fills the height of the chart column and scrolls inside. */}
        <div className="h-[560px] lg:relative lg:h-auto">
          <div className="h-full lg:absolute lg:inset-0">
            <ArenaPanel data={data} />
          </div>
        </div>
      </div>
    </div>
  );
}
