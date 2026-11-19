'use client';

import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { RaceChart, slotColor } from '@/components/race-chart';
import { SidePill } from '@/components/thesis-card';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, contracts, percent, usd } from '@/lib/format';
import { raceDate, type RacePositionView, type RaceResponse, type RaceSideView } from '@/lib/race-view';
import { signedUsd } from '@/lib/record-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The race page: both account values over time, then each agent's open positions, the
 * reasoning behind them, and the last decision it made. Re-reads every five seconds.
 */

const RACE_REFRESH_MS = 5000;

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const changeClass = (value: number) => (value > 0.004 ? 'text-yes' : value < -0.004 ? 'text-no' : 'text-muted-foreground');

function Position({ position }: { position: RacePositionView }) {
  const pnl = Number(position.pnlUsd);
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Link
          href={`/markets/${encodeURIComponent(position.market.symbol)}`}
          className="block text-sm leading-snug underline-offset-4 hover:underline"
        >
          {position.market.title}
          {position.market.contractLabel && <span className="text-muted-foreground">, {position.market.contractLabel}</span>}
        </Link>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground tabular-nums">
          <SidePill side={position.side} />
          {contracts(position.quantity)} at {cents(position.entryPrice)}
          {position.markPrice !== null && <>, now {cents(position.markPrice)}</>}
        </p>
      </div>
      <span className={cn('pt-0.5 text-sm tabular-nums', changeClass(pnl))}>{signedUsd(pnl)}</span>
    </li>
  );
}

function AgentColumn({ race, side, now }: { race: RaceResponse; side: RaceSideView; now: Date }) {
  const change = Number(side.changeUsd);
  return (
    <section aria-labelledby={`agent-${side.slot}`} className="min-w-0 space-y-6">
      <header className="space-y-2">
        <h2 id={`agent-${side.slot}`} className="flex items-center gap-2 text-[17px] font-medium">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: slotColor(race, side.slot) }} />
          {side.authorId ? (
            <Link href={`/authors/${side.authorId}`} className="underline-offset-4 hover:underline">
              {side.name}
            </Link>
          ) : (
            side.name
          )}
        </h2>
        <p className="tabular-nums">
          <span className="text-[22px] font-medium">{usd(side.valueUsd)}</span>{' '}
          <span className={cn('text-sm', changeClass(change))}>
            {signedUsd(change)} vs {usd(race.bankrollUsd)} start
          </span>
        </p>
        {side.strategy && <p className="text-sm leading-relaxed text-muted-foreground">{side.strategy}</p>}
      </header>

      <div>
        <h3 className="text-sm font-medium">
          Open positions <span className="font-normal text-muted-foreground tabular-nums">{side.positions.length}</span>
        </h3>
        {side.positions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {side.tradeCount === 0 ? `${side.name} has not traded yet.` : 'None open right now. Every position has settled.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {side.positions.map((position) => (
              <Position key={position.tradeId} position={position} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Current reasoning</h3>
        {side.thesis ? (
          <article className="space-y-2 rounded-lg border border-border p-4">
            <Link href={`/thesis/${side.thesis.id}`} className="block text-[15px] leading-snug font-medium underline-offset-4 hover:underline">
              {side.thesis.headline}
            </Link>
            <p className="text-[13px] text-muted-foreground">Puts YES at {percent(side.thesis.probabilityYes)}</p>
            <p className="line-clamp-6 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{side.thesis.body}</p>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">No thesis yet.</p>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Latest decision</h3>
        {side.lastLook ? (
          <p className="text-sm leading-relaxed">
            <span className="text-muted-foreground">
              {side.lastLook.decision === 'trade' ? 'Traded' : 'Passed'}, {ago(side.lastLook.at, now)}
              {side.lastLook.market && <> on {side.lastLook.market}</>}.
            </span>{' '}
            {side.lastLook.reason}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No decisions logged yet.</p>
        )}
      </div>
    </section>
  );
}

function Lead({ race }: { race: RaceResponse }) {
  if (race.points.length === 0) {
    return <>Neither agent has opened a position yet. Both start with {usd(race.bankrollUsd)} of test money.</>;
  }
  if (!race.leader) return <>Level at {usd(race.a.valueUsd)}.</>;
  const lead = race[race.leader];
  return (
    <>
      {lead.name} leads by <span className="text-primary tabular-nums">{usd(race.leadUsd)}</span>
      {race.deal && (
        <>
          , most of it on{' '}
          <Link href={`/markets/${encodeURIComponent(race.deal.symbol)}`} className="underline-offset-4 hover:underline">
            {race.deal.label}
          </Link>
        </>
      )}
      .
    </>
  );
}

export function RaceDetail({ pair, initial }: { pair: string; initial: RaceResponse | undefined }) {
  const { data: race, error, retry } = useLive<RaceResponse>(`/api/race/${pair}`, initial, RACE_REFRESH_MS);
  const { now } = useNow(initial?.asOf);

  if (!race) {
    return error ? (
      <LoadError message={error.message} onRetry={retry} />
    ) : (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Agent race{race.since ? `, since ${raceDate(race.since)}` : ''}. Each started with {usd(race.bankrollUsd)} of test money.
        </p>
        <h1 className="text-[22px] leading-tight font-medium">
          {race.a.name} vs {race.b.name}
        </h1>
        <p className="text-[15px] leading-relaxed">
          <Lead race={race} />
        </p>
      </header>

      {race.points.length > 1 && (
        <figure className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="h-72 sm:h-80">
            <RaceChart race={race} variant="full" />
          </div>
          <figcaption className="text-[13px] leading-relaxed text-muted-foreground">
            Account value: {usd(race.bankrollUsd)}, less what positions cost, plus what settled ones paid, with open positions
            at Gemini&rsquo;s current midpoint. Triangles mark positions opened: up for YES, down for NO.
          </figcaption>
        </figure>
      )}

      {error && <LoadError message={error.message} onRetry={retry} />}

      <div className="grid gap-10 md:grid-cols-2 md:gap-8">
        <AgentColumn race={race} side={race.a} now={now} />
        <AgentColumn race={race} side={race.b} now={now} />
      </div>
    </div>
  );
}
