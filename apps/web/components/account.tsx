'use client';

import { LIMIT_BOUNDS } from '@thesis/core/browser';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { LoadError } from '@/components/load-error';
import { SidePill } from '@/components/thesis-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cents, contracts, usd } from '@/lib/format';
import {
  signedUsd,
  tipStatusText,
  usdc,
  type AccountResponse,
  type PositionView,
  type TipView,
} from '@/lib/record-view';
import { EXPLORER_ADDRESS, EXPLORER_TX, isTxHash, type MeResponse } from '@/lib/thesis-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-base tabular-nums';
const link = 'text-primary underline-offset-4 hover:underline';

/** A UTC day as "November 20". */
const utcDayText = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

function Limits({ me, onSaved }: { me: MeResponse; onSaved: () => void }) {
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
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving limits' : 'Save limits'}
        </Button>
        <p className="text-sm text-muted-foreground">
          Lowering a limit applies at once. Raising one starts the next UTC day.
        </p>
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={cn('text-sm', !message.ok && 'text-no')}>
          {message.text}
        </p>
      )}
    </form>
  );
}

function PositionRow({ position }: { position: PositionView }) {
  const profit = position.payoutUsd === null ? null : Number(position.payoutUsd) - Number(position.costUsd);
  const title = position.headline ?? position.marketTitle;
  return (
    <li className="space-y-1 py-3 text-sm">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <SidePill side={position.side} />
        </span>
        {position.thesisId ? (
          <Link href={`/thesis/${position.thesisId}`} className="font-medium underline-offset-4 hover:underline">
            {title}
          </Link>
        ) : (
          <span className="font-medium">{title}</span>
        )}
      </div>
      <p className="text-muted-foreground">
        {position.own ? 'Your thesis' : 'Copied'} on{' '}
        <Link href={`/markets/${encodeURIComponent(position.marketSymbol)}`} className="underline-offset-4 hover:underline">
          {position.marketTitle}
        </Link>
        {position.contractLabel && `, ${position.contractLabel}`}
      </p>
      <p className="tabular-nums">
        {contracts(position.quantity)} contracts at {cents(position.price)}, cost {usd(position.costUsd)}.{' '}
        {profit === null ? (
          <span className="text-muted-foreground">
            Pays {usd(Number(position.quantity))} if {position.side.toUpperCase()} wins.
          </span>
        ) : (
          <span className={cn('font-medium', profit > 0.004 && 'text-yes', profit < -0.004 && 'text-no')}>
            Paid {usd(position.payoutUsd)}, {signedUsd(profit)}.
          </span>
        )}
      </p>
    </li>
  );
}

function TipRow({ tip }: { tip: TipView }) {
  const tx = isTxHash(tip.settleTx) ? tip.settleTx : isTxHash(tip.depositTx) ? tip.depositTx : null;
  return (
    <li className="space-y-1 py-3 text-sm">
      <Link href={`/thesis/${tip.thesisId}`} className="font-medium underline-offset-4 hover:underline">
        {tip.headline}
      </Link>
      <p className="tabular-nums">
        {usdc(tip.amountUsdc)} USDC. {tipStatusText(tip.status)}.{' '}
        {tx && (
          <a href={`${EXPLORER_TX}${tx}`} target="_blank" rel="noreferrer" className={link}>
            See the transaction
          </a>
        )}
      </p>
    </li>
  );
}

export function Account({ initial }: { initial: AccountResponse }) {
  const { data, error, retry } = useLive<AccountResponse>('/api/me', initial, 10_000);
  const me = data ?? initial;
  const copied = Number(me.copiedTodayUsd);
  const cap = Number(me.dailyCopyCapUsd);
  const open = me.positions.filter((p) => !p.settled);
  const settled = me.positions.filter((p) => p.settled);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{me.displayName}</h1>
        <p className="text-muted-foreground">A guest session on this browser. All funds here are simulated.</p>
      </header>

      {error && <LoadError message={`${error.message} Showing the last figures read.`} onRetry={retry} />}

      <section aria-label="Balances" className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div>
          <div className="text-sm text-muted-foreground">Paper balance, for trades</div>
          <div className="text-3xl font-semibold tracking-tight tabular-nums">{usd(me.paperBalanceUsd)}</div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Tip wallet, test USDC on Arc testnet</div>
          {me.walletAddress ? (
            <>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">
                {me.tipBalanceUsdc === null ? '–' : `${me.tipBalanceUsdc} USDC`}
              </div>
              <a href={`${EXPLORER_ADDRESS}${me.walletAddress}`} target="_blank" rel="noreferrer" className={cn(link, 'text-sm')}>
                See the wallet on the explorer
              </a>
            </>
          ) : (
            <p className="text-sm">
              You have no wallet yet. One is made for you, with test USDC in it, the first time you add a tip to a
              copy.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="today-heading" className="space-y-2">
        <h2 id="today-heading" className="text-lg font-semibold">
          Copied today
        </h2>
        <p className="text-sm tabular-nums">
          {usd(copied)} of your {usd(cap)} daily cap. {usd(Math.max(0, cap - copied))} left until midnight UTC.
        </p>
        <div
          role="progressbar"
          aria-label="Share of today's cap used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, cap > 0 ? copied / cap : 0) * 100)}
          className="h-2 overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, cap > 0 ? (copied / cap) * 100 : 0)}%` }} />
        </div>
      </section>

      <section aria-labelledby="limits-heading" className="space-y-3">
        <h2 id="limits-heading" className="text-lg font-semibold">
          Your limits
        </h2>
        {/* The key resets the form's fields when a saved or due change arrives. */}
        <Limits key={`${me.maxPerTradeUsd}:${me.dailyCopyCapUsd}`} me={me} onSaved={retry} />
      </section>

      <section aria-labelledby="open-heading" className="space-y-2">
        <h2 id="open-heading" className="text-lg font-semibold">
          Open positions ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm">
            You hold nothing right now.{' '}
            <Link href="/" className={link}>
              Find a thesis to copy
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y border-y">
            {open.map((p) => (
              <PositionRow key={p.tradeId} position={p} />
            ))}
          </ul>
        )}
      </section>

      {settled.length > 0 && (
        <section aria-labelledby="settled-heading" className="space-y-2">
          <h2 id="settled-heading" className="text-lg font-semibold">
            Settled positions ({settled.length})
          </h2>
          <ul className="divide-y border-y">
            {settled.map((p) => (
              <PositionRow key={p.tradeId} position={p} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="tips-heading" className="space-y-2">
        <h2 id="tips-heading" className="text-lg font-semibold">
          Your tips ({me.tips.length})
        </h2>
        {me.tips.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have not tipped yet. A tip goes to the author only if their thesis turns out right; otherwise it
            comes back to you.
          </p>
        ) : (
          <ul className="divide-y border-y">
            {me.tips.map((tip) => (
              <TipRow key={tip.tipId} tip={tip} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="gemini-heading" className="space-y-2">
        <h2 id="gemini-heading" className="text-lg font-semibold">
          Connect Gemini
        </h2>
        <p className="max-w-prose text-sm">
          Not available in this build. Every trade here is a simulated fill at Gemini's live price, and no order
          is sent to a Gemini account.{' '}
          <Link href="/how-it-works" className={link}>
            What is live and what is simulated
          </Link>
        </p>
      </section>
    </div>
  );
}

export function AccountSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
