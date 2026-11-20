'use client';

import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import { InfoTip } from '@/components/info-tip';
import { SidePill } from '@/components/thesis-card';
import { cents, contracts, usd } from '@/lib/format';
import { signedUsd, type PositionView } from '@/lib/record-view';
import { cn } from '@/lib/utils';

/**
 * The parts the Me page and an author's profile share, so the two read as one design:
 * the figure with its line, the row of figures, the tabs and the position rows.
 */

export const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm text-muted-foreground';
export const textLink = 'text-primary underline-offset-4 hover:underline';

/** "Nov 18", in UTC so the server and the browser agree. */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 19, 3:40 PM" in the reader's own time. Only drawn in the browser, while scrubbing. */
export const momentText = (t: number) =>
  new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const tone = (amount: number) =>
  amount > 0.004 ? 'text-yes' : amount < -0.004 ? 'text-no' : 'text-muted-foreground';

/** The headline figure at the top right: a label, a large number, a line under it, the chart. */
export function FigureBlock({
  label,
  tip,
  figure,
  sub,
  chart,
  note,
}: {
  label: string;
  tip: ReactNode;
  figure: string;
  sub: ReactNode;
  chart: ReactNode;
  /** Shown under the chart while it has no line to draw. */
  note?: string;
}) {
  return (
    <div className="min-w-0 lg:text-right">
      <p className="flex h-6 items-center gap-0.5 text-sm text-muted-foreground lg:justify-end">
        {label}
        <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>
      </p>
      <p className="mt-1 text-4xl font-medium tracking-tight tabular-nums lg:text-5xl">{figure}</p>
      <p className="mt-2 text-sm tabular-nums">{sub}</p>
      {chart}
      {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

/** Who the page is about: avatar, name, a tag, the tip wallet, and a few facts as chips. */
export function Identity({
  avatar,
  name,
  tag,
  wallet,
  bio,
  chips,
}: {
  avatar: ReactNode;
  name: string;
  tag: ReactNode;
  wallet: ReactNode;
  bio?: string | null;
  chips: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-4 lg:gap-5">
      {avatar}
      <div className="min-w-0 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-2xl font-medium tracking-tight lg:text-3xl">{name}</h1>
          {tag}
        </div>
        {wallet}
        {bio && <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">{bio}</p>}
        <ul className="mt-4 flex flex-wrap gap-2">{chips}</ul>
      </div>
    </div>
  );
}

/** A tip wallet's short address, linking to the explorer. */
export function WalletLink({ address, href, label }: { address: string; href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-1 inline-flex items-center gap-0.5 text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground"
    >
      {shortAddress(address)}
      <ArrowUpRight aria-hidden className="size-3.5" />
      <span className="sr-only">{label}</span>
    </a>
  );
}

export function Stat({ label, tip, children }: { label: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex h-6 items-center gap-0.5 text-sm text-muted-foreground">
        {label}
        {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
      </p>
      <p className="mt-1 truncate text-lg font-medium tabular-nums">{children}</p>
    </div>
  );
}

export function Divider() {
  return <span aria-hidden className="hidden h-12 w-px self-center bg-border xl:block" />;
}

/** The row of figures under the header. */
export function FigureRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4 xl:flex xl:flex-wrap xl:items-end xl:gap-x-8"
    >
      {children}
    </section>
  );
}

export function Tabs<K extends string>({
  label,
  tabs,
  active,
  onChange,
}: {
  label: string;
  tabs: Array<{ key: K; label: string; count: number }>;
  active: K;
  onChange: (key: K) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.key === active);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    onChange(next.key);
    document.getElementById(`tab-${next.key}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-6 border-b sm:gap-8">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            id={`tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            className={cn(
              'relative flex h-12 items-center gap-1.5 text-[15px] whitespace-nowrap transition-colors',
              selected ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            <span className="text-sm font-normal text-muted-foreground tabular-nums">{tab.count}</span>
            {selected && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One position: the side and headline, then where and how much, then cost and worth.
 * `prefix` says whose it is ("Your thesis", "Copied"); an author's profile has none, since
 * every row there is the author's own.
 */
export function PositionRow({ position, prefix }: { position: PositionView; prefix: string | null }) {
  const cost = Number(position.costUsd);
  const title = position.headline ?? position.marketTitle;
  const worth = position.settled
    ? Number(position.payoutUsd ?? 0)
    : position.valueUsd === null
      ? null
      : Number(position.valueUsd);
  const market = (
    <Link href={`/markets/${encodeURIComponent(position.marketSymbol)}`} className="underline-offset-4 hover:underline">
      {position.contractLabel ? position.marketTitle.replace(/\?\s*$/, '') : position.marketTitle}
    </Link>
  );
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b py-4 sm:grid-cols-[minmax(0,1fr)_96px_128px]">
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            <SidePill side={position.side} />
          </span>
          {position.thesisId ? (
            <Link href={`/thesis/${position.thesisId}`} className="line-clamp-2 font-medium underline-offset-4 hover:underline">
              {title}
            </Link>
          ) : (
            <span className="line-clamp-2 font-medium">{title}</span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {prefix}
          {/* The title already names the market when there is no thesis headline. */}
          {position.headline && (prefix ? <> on {market}</> : market)}
          {position.contractLabel && `, ${position.contractLabel}`}. {contracts(position.quantity)} contracts at{' '}
          {cents(position.price)}
          <span className="sm:hidden">, cost {usd(cost)}</span>
          {!position.settled && `, pays ${usd(Number(position.quantity))} if ${position.side.toUpperCase()} wins`}
        </p>
      </div>
      <p className="hidden text-right tabular-nums sm:block">{usd(cost)}</p>
      <div className="text-right tabular-nums">
        <p>{worth === null ? usd(cost) : usd(worth)}</p>
        {worth !== null && <p className={cn('text-sm', tone(worth - cost))}>{signedUsd(worth - cost)}</p>}
      </div>
    </li>
  );
}

export function PositionList({
  positions,
  settled,
  prefix,
  empty,
}: {
  positions: PositionView[];
  settled: boolean;
  prefix: (position: PositionView) => string | null;
  empty: ReactNode;
}) {
  if (positions.length === 0) return <p className="py-8 text-sm text-muted-foreground">{empty}</p>;
  return (
    <>
      <div className="hidden grid-cols-[minmax(0,1fr)_96px_128px] gap-x-6 border-b py-3 text-sm text-muted-foreground sm:grid">
        <span>Position</span>
        <span className="text-right">Cost</span>
        <span className="text-right">{settled ? 'Paid' : 'Worth now'}</span>
      </div>
      <ul>
        {positions.map((p) => (
          <PositionRow key={p.tradeId} position={p} prefix={prefix(p)} />
        ))}
      </ul>
    </>
  );
}
