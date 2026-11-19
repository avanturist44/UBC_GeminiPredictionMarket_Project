'use client';

import { LIMIT_BOUNDS } from '@thesis/core/browser';
import { ArrowUpRight, CalendarDays, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AccountChart } from '@/components/account-chart';
import { Avatar } from '@/components/avatar';
import { InfoTip } from '@/components/info-tip';
import { LoadError } from '@/components/load-error';
import { SidePill } from '@/components/thesis-card';
import { Button } from '@/components/ui/button';
import { cents, contracts, usd } from '@/lib/format';
import {
  signedUsd,
  tipStatusText,
  usdc,
  type AccountResponse,
  type PortfolioPoint,
  type PortfolioView,
  type PositionView,
  type TipView,
} from '@/lib/record-view';
import { EXPLORER_ADDRESS, EXPLORER_TX, isTxHash, type MeResponse } from '@/lib/thesis-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-base tabular-nums';
const link = 'text-primary underline-offset-4 hover:underline';
const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm text-muted-foreground';

/** A UTC day as "November 20". */
const utcDayText = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
/** "Nov 18", in UTC so the server and the browser agree. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 19, 3:40 PM" in the reader's own time. Only drawn in the browser, while scrubbing. */
const momentText = (t: number) =>
  new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const tone = (amount: number) => (amount > 0.004 ? 'text-yes' : amount < -0.004 ? 'text-no' : 'text-muted-foreground');

function signedPercent(change: number, start: number): string {
  const pct = start > 0 ? (change / start) * 100 : 0;
  if (Math.abs(pct) < 0.005) return '0.00%';
  return `${pct > 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`;
}

function Limits({ me, onSaved, onClose }: { me: MeResponse; onSaved: () => void; onClose: () => void }) {
  const [perTrade, setPerTrade] = useState(String(Number(me.maxPerTradeUsd)));
  const [daily, setDaily] = useState(String(Number(me.dailyCopyCapUsd)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const pending = me.pendingLimits;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/me/limits', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxPerTradeUsd: Number(perTrade), dailyCopyCapUsd: Number(daily) }),
      });
      const body = (await response.json().catch(() => null)) as (MeResponse & { message?: string }) | null;
      if (!response.ok || !body) {
        setMessage({ ok: false, text: body?.message ?? `The limits were not saved (status ${response.status}).` });
        return;
      }
      setMessage({
        ok: true,
        text: body.pendingLimits
          ? `Saved. A higher limit starts on ${utcDayText(body.pendingLimits.effectiveOn)} (UTC); until then the current one applies.`
          : 'Saved. The limits apply now.',
      });
      onSaved();
    } catch {
      setMessage({ ok: false, text: 'The limits were not saved: the server could not be reached.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-5 space-y-4">
      <div className="space-y-1">
        <label htmlFor="per-trade" className="block text-sm font-medium">
          Most per copy trade, in dollars
        </label>
        <input
          id="per-trade"
          type="number"
          inputMode="decimal"
          required
          min={LIMIT_BOUNDS.maxPerTradeUsd.min}
          max={LIMIT_BOUNDS.maxPerTradeUsd.max}
          step="0.01"
          value={perTrade}
          onChange={(e) => setPerTrade(e.target.value)}
          className={field}
        />
        <p className="text-sm text-muted-foreground">
          Now {usd(me.maxPerTradeUsd)}
          {pending?.maxPerTradeUsd && `, rising to ${usd(pending.maxPerTradeUsd)} on ${utcDayText(pending.effectiveOn)}`}.
          Between ${LIMIT_BOUNDS.maxPerTradeUsd.min} and ${LIMIT_BOUNDS.maxPerTradeUsd.max}.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="daily-cap" className="block text-sm font-medium">
          Most copied per day, in dollars
        </label>
        <input
          id="daily-cap"
          type="number"
          inputMode="decimal"
          required
          min={LIMIT_BOUNDS.dailyCopyCapUsd.min}
          max={LIMIT_BOUNDS.dailyCopyCapUsd.max}
          step="0.01"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          className={field}
        />
        <p className="text-sm text-muted-foreground">
          Now {usd(me.dailyCopyCapUsd)}
          {pending?.dailyCopyCapUsd && `, rising to ${usd(pending.dailyCopyCapUsd)} on ${utcDayText(pending.effectiveOn)}`}.
          Between ${LIMIT_BOUNDS.dailyCopyCapUsd.min} and ${LIMIT_BOUNDS.dailyCopyCapUsd.max}.
        </p>
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={cn('text-sm', !message.ok && 'text-no')}>
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving limits' : 'Save limits'}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {message?.ok ? 'Done' : 'Cancel'}
        </Button>
      </div>
    </form>
  );
}

/** The limits, out of the way until wanted: a button that opens them in a dialog. */
function LimitsButton({ me, onSaved }: { me: MeResponse; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A new key per opening, so the form starts from the saved values each time.
  const [opening, setOpening] = useState(0);
  const close = () => dialog.current?.close();
  return (
    <>
      <Button
        variant="outline"
        className="h-9 gap-2"
        onClick={() => {
          setOpening((n) => n + 1);
          dialog.current?.showModal();
        }}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
        Limits
        {me.pendingLimits && <span className="size-1.5 rounded-full bg-primary" aria-label="A raise is waiting" />}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="limits-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-5 text-left text-foreground backdrop:bg-black/60"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="limits-title" className="text-lg font-medium">
              Your limits
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Lowering a limit applies at once. Raising one starts the next UTC day.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <Limits key={opening} me={me} onSaved={onSaved} onClose={close} />
      </dialog>
    </>
  );
}

/** The headline figure and the line behind it. Pointing at the line shows that moment. */
function AccountValue({ portfolio }: { portfolio: PortfolioView }) {
  const [scrub, setScrub] = useState<PortfolioPoint | null>(null);
  const start = Number(portfolio.startUsd);
  const value = scrub ? scrub.v : Number(portfolio.valueUsd);
  const change = value - start;
  const hasLine = portfolio.points.length >= 2;
  return (
    <div className="min-w-0 lg:text-right">
      <p className="flex h-6 items-center gap-0.5 text-sm text-muted-foreground lg:justify-end">
        Account value
        <InfoTip label="About account value">
          Your cash plus your open positions at Gemini&apos;s live prices, in test dollars. The line starts at your
          first position.
        </InfoTip>
      </p>
      <p className="mt-1 text-4xl font-medium tracking-tight tabular-nums lg:text-5xl">{usd(value)}</p>
      <p className="mt-2 text-sm tabular-nums">
        {portfolio.since ? (
          <>
            <span className={tone(change)}>
              {signedUsd(change)} ({signedPercent(change, start)})
            </span>{' '}
            <span className="text-muted-foreground">
              {scrub ? `at ${momentText(scrub.t)}` : `since ${shortDate(portfolio.since)}`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No positions yet</span>
        )}
      </p>
      <AccountChart
        className="mt-4 h-24 lg:h-28"
        points={portfolio.points}
        startUsd={start}
        onScrub={setScrub}
        label={
          hasLine
            ? `Account value from ${usd(start)} at your first position to ${usd(portfolio.valueUsd)} now`
            : 'No account line yet'
        }
      />
      {!hasLine && <p className="mt-2 text-sm text-muted-foreground">The line starts with your first position.</p>}
    </div>
  );
}

function Stat({ label, tip, children }: { label: string; tip?: ReactNode; children: ReactNode }) {
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

function Divider() {
  return <span aria-hidden className="hidden h-12 w-px self-center bg-border xl:block" />;
}

type TabKey = 'open' | 'settled' | 'tips';

function PositionRow({ position }: { position: PositionView }) {
  const cost = Number(position.costUsd);
  const title = position.headline ?? position.marketTitle;
  const worth = position.settled ? Number(position.payoutUsd ?? 0) : position.valueUsd === null ? null : Number(position.valueUsd);
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
          {position.own ? 'Your thesis' : 'Copied'}
          {/* The title already names the market when there is no thesis headline. */}
          {position.headline && (
            <>
              {' '}
              on{' '}
              <Link
                href={`/markets/${encodeURIComponent(position.marketSymbol)}`}
                className="underline-offset-4 hover:underline"
              >
                {position.contractLabel ? position.marketTitle.replace(/\?\s*$/, '') : position.marketTitle}
              </Link>
            </>
          )}
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

function PositionList({ positions, settled }: { positions: PositionView[]; settled: boolean }) {
  if (positions.length === 0) {
    return settled ? (
      <p className="py-8 text-sm text-muted-foreground">
        Nothing has settled yet. A position settles when its market resolves.
      </p>
    ) : (
      <p className="py-8 text-sm text-muted-foreground">
        You hold nothing right now.{' '}
        <Link href="/" className={link}>
          Find a thesis to copy
        </Link>
      </p>
    );
  }
  return (
    <>
      <div className="hidden grid-cols-[minmax(0,1fr)_96px_128px] gap-x-6 border-b py-3 text-sm text-muted-foreground sm:grid">
        <span>Position</span>
        <span className="text-right">Cost</span>
        <span className="text-right">{settled ? 'Paid' : 'Worth now'}</span>
      </div>
      <ul>
        {positions.map((p) => (
          <PositionRow key={p.tradeId} position={p} />
        ))}
      </ul>
    </>
  );
}

function TipRow({ tip }: { tip: TipView }) {
  const tx = isTxHash(tip.settleTx) ? tip.settleTx : isTxHash(tip.depositTx) ? tip.depositTx : null;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b py-4">
      <div className="min-w-0">
        <Link href={`/thesis/${tip.thesisId}`} className="line-clamp-2 font-medium underline-offset-4 hover:underline">
          {tip.headline}
        </Link>
        <p className="mt-1 text-sm text-muted-foreground">{tipStatusText(tip.status)}</p>
      </div>
      <div className="text-right tabular-nums">
        <p>{usdc(tip.amountUsdc)} USDC</p>
        {tx && (
          <a
            href={`${EXPLORER_TX}${tx}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-sm text-primary underline-offset-4 hover:underline"
          >
            Transaction
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}

function TipList({ tips }: { tips: TipView[] }) {
  if (tips.length === 0) {
    return (
      <p className="py-8 text-sm text-muted-foreground">
        You have not tipped yet. A tip goes to the author only if their thesis turns out right; otherwise it comes
        back to you.
      </p>
    );
  }
  return (
    <ul>
      {tips.map((tip) => (
        <TipRow key={tip.tipId} tip={tip} />
      ))}
    </ul>
  );
}

function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: TabKey; label: string; count: number }>;
  active: TabKey;
  onChange: (key: TabKey) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.key === active);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    onChange(next.key);
    document.getElementById(`tab-${next.key}`)?.focus();
  }
  return (
    <div role="tablist" aria-label="Your positions and tips" onKeyDown={onKeyDown} className="flex gap-6 border-b sm:gap-8">
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

export function Account({ initial }: { initial: AccountResponse }) {
  const { data, error, retry } = useLive<AccountResponse>('/api/me', initial, 10_000);
  const me = data ?? initial;
  const [tab, setTab] = useState<TabKey>('open');
  const open = me.positions.filter((p) => !p.settled);
  const settled = me.positions.filter((p) => p.settled);
  const walletTip = (
    <>
      Test USDC on Arc testnet, for tipping authors.
      {!me.walletAddress &&
        ' You have no wallet yet. One is made for you, with test USDC in it, the first time you add a tip to a copy.'}
    </>
  );

  return (
    <div>
      <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-12">
        <div className="flex min-w-0 items-start gap-4 lg:gap-5">
          <Avatar name={me.displayName} kind="human" className="size-16 text-xl lg:size-20 lg:text-2xl" />
          <div className="min-w-0 pt-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-2xl font-medium tracking-tight lg:text-3xl">{me.displayName}</h1>
              <span className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                Guest
              </span>
              <InfoTip label="About guest sessions">
                A guest session on this browser. All funds here are simulated.
              </InfoTip>
            </div>
            {me.walletAddress ? (
              <a
                href={`${EXPLORER_ADDRESS}${me.walletAddress}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-0.5 text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground"
              >
                {shortAddress(me.walletAddress)}
                <ArrowUpRight aria-hidden className="size-3.5" />
                <span className="sr-only">See the tip wallet on the explorer</span>
              </a>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">No tip wallet yet</p>
            )}
            <ul className="mt-4 flex flex-wrap gap-2">
              <li className={chip}>
                <CalendarDays aria-hidden className="size-4" />
                Joined {shortDate(me.joinedAt)}
              </li>
              <li className={chip}>
                Gemini not connected
                <InfoTip label="About connecting Gemini">
                  Not available in this build. Every trade here is a simulated fill at Gemini&apos;s live price, and
                  no order is sent to a Gemini account.
                </InfoTip>
              </li>
            </ul>
          </div>
        </div>
        <AccountValue portfolio={me.portfolio} />
      </header>

      {error && (
        <div className="mt-6">
          <LoadError message={`${error.message} Showing the last figures read.`} onRetry={retry} />
        </div>
      )}

      <section
        aria-label="Your figures"
        className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4 xl:flex xl:flex-wrap xl:items-end xl:gap-x-8"
      >
        <Stat label="Cash" tip="Test dollars you can trade with. Every guest starts with $1,000.">
          {usd(me.paperBalanceUsd)}
        </Stat>
        <Stat label="In positions">{usd(me.portfolio.openValueUsd)}</Stat>
        <Stat label="Copied today" tip="What your copies cost today, against your daily cap. It resets at midnight UTC.">
          {usd(me.copiedTodayUsd)}
          <span className="text-sm font-normal text-muted-foreground"> of {usd(me.dailyCopyCapUsd)}</span>
        </Stat>
        <div className="flex items-end">
          <LimitsButton me={me} onSaved={retry} />
        </div>
        <Divider />
        <Stat label="Copying">
          {me.stats.copying}
          <span className="text-sm font-normal text-muted-foreground">
            {' '}
            {me.stats.copying === 1 ? 'author' : 'authors'}
          </span>
        </Stat>
        <Stat label="Copiers" tip="People who have copied a thesis you wrote.">
          {me.stats.copiers}
        </Stat>
        <Stat label="Tips earned" tip="Tips paid to you because a thesis you wrote turned out right.">
          {usdc(me.stats.tipsEarnedUsdc)} USDC
        </Stat>
        <Divider />
        <Stat label="Tip wallet" tip={walletTip}>
          {me.walletAddress ? `${me.tipBalanceUsdc ?? '–'} USDC` : 'None yet'}
        </Stat>
      </section>

      <div className="mt-10">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'open', label: 'Open positions', count: open.length },
            { key: 'settled', label: 'Settled', count: settled.length },
            { key: 'tips', label: 'Tips', count: me.tips.length },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'tips' ? (
            <TipList tips={me.tips} />
          ) : (
            <PositionList positions={tab === 'open' ? open : settled} settled={tab === 'settled'} />
          )}
        </div>
      </div>
    </div>
  );
}
