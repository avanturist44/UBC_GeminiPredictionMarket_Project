'use client';

import { MAX_QUOTE_AGE_MS, TIP_CHOICES_USDC } from '@thesis/core/browser';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CopyResponse } from '@/lib/copy-trade';
import { cents, contracts, timeLeft, usd } from '@/lib/format';
import type { ApiError } from '@/lib/market-view';
import { EXPLORER_TX, isTxHash, type MeResponse, type ThesisCardView, type TipStatusResponse } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The Copy trade button and its confirmation. One screen, in a fixed order: the trade in
 * plain words, the amount, the tip, what it can lose and what it pays, how it is filled,
 * Confirm. Nothing is placed until Confirm, and every number is checked again on the server.
 */

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`).replace(
    /[^A-Za-z0-9_-]/g,
    '',
  );

async function post<T>(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError & { price?: string } }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: json as T };
  return {
    ok: false,
    error: (json as ApiError | null) ?? { code: 'failed', message: `The request failed (${response.status}).` },
  };
}

/** Why this thesis cannot be copied right now, or null when it can. */
export function copyBlockedReason(thesis: ThesisCardView, now: Date): string | null {
  if (thesis.status === 'resolved') return 'This market has resolved.';
  if (thesis.status !== 'published') return 'This thesis is not published.';
  const left = timeLeft(thesis.market.expiryAt ? new Date(thesis.market.expiryAt) : null, now);
  if (left.over || thesis.market.marketState !== 'open') return 'This market has closed.';
  if (thesis.market.expiryAt && new Date(thesis.market.expiryAt).getTime() - now.getTime() < 2 * 60_000) {
    return 'This market closes in under 2 minutes.';
  }
  // The server refuses a fill on an old quote, so say so before anyone fills in the dialog.
  if (now.getTime() - Date.parse(thesis.market.quoteAt) > MAX_QUOTE_AGE_MS) {
    return 'Prices for this market are not updating right now, so it cannot be copied. Try again in a minute.';
  }
  if (thesis.currentPrice === null) return `Nobody is selling ${thesis.side.toUpperCase()} right now.`;
  return null;
}

/** A tip on its way: pending, then in escrow with a link to the transaction. */
function TipProgress({ tipId, amountUsdc }: { tipId: string; amountUsdc: string }) {
  const { data } = useLive<TipStatusResponse>(`/api/tips/${tipId}`, undefined, 2000);
  const amount = `${Number(amountUsdc).toFixed(2)} USDC`;
  const status = data?.status ?? 'pending';
  return (
    <p role="status" className="rounded-lg border p-3 text-sm">
      {status === 'pending' && `Your tip of ${amount} is on its way to escrow. This takes a few seconds.`}
      {status === 'escrowed' && (
        <>
          Your tip of {amount} is in escrow. It goes to the author only if the thesis is right; if it is wrong it
          comes back to you.{' '}
          {isTxHash(data?.depositTx) && (
            <a
              href={EXPLORER_TX + data.depositTx}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              See the transaction
            </a>
          )}
        </>
      )}
      {status === 'failed' && `Your tip of ${amount} did not go through, and nothing was taken. Your trade is unaffected.`}
      {status === 'paid' && `Your tip of ${amount} was paid to the author.`}
      {status === 'refunded' && `Your tip of ${amount} was returned to you.`}
    </p>
  );
}

/** The blocked reason in a word or two, for the small button on a post. */
function shortReason(reason: string): string {
  if (reason.includes('resolved')) return 'Resolved';
  if (reason.includes('closes in under')) return 'Closing';
  if (reason.includes('closed')) return 'Closed';
  if (reason.startsWith('Nobody is selling')) return 'No seller';
  if (reason.startsWith('Prices for this market')) return 'Prices paused';
  return 'Unavailable';
}

/**
 * `compact` is the button on a post in the feed: one line, the reason it is off in a word.
 * The thesis page uses the full button with the reason written out under it.
 */
export function CopyTrade({
  thesis,
  viewerIsAuthor,
  compact = false,
  wide = false,
}: {
  thesis: ThesisCardView;
  viewerIsAuthor: boolean;
  compact?: boolean;
  /** The full button stretched to its container, as on the thesis page's position card. */
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { now } = useNow(undefined);
  const { data: me, retry: reloadMe } = useLive<MeResponse>('/api/me', undefined, 15_000);
  const [amount, setAmount] = useState('5');
  const [tip, setTip] = useState<string>('0');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [newPrice, setNewPrice] = useState<string | null>(null);
  const [done, setDone] = useState<CopyResponse | null>(null);
  const [key, setKey] = useState(newKey);

  const blocked = viewerIsAuthor ? 'You cannot copy your own thesis.' : copyBlockedReason(thesis, now);
  const price = newPrice ?? thesis.currentPrice;
  const amountNumber = Number(amount);
  const quantity = price && amountNumber > 0 ? Math.floor((amountNumber / Number(price)) * 100) / 100 : 0;
  const cost = price ? quantity * Number(price) : 0;
  const cap = Number(me?.maxPerTradeUsd ?? 10);
  const leftToday = me ? Math.max(0, Number(me.dailyCopyCapUsd) - Number(me.copiedTodayUsd)) : 25;
  const ready = price !== null && quantity > 0 && amountNumber <= cap && amountNumber <= leftToday;

  // A stale "price moved" notice must not survive closing the dialog.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClose = () => {
      setProblem(null);
      setNewPrice(null);
      setDone(null);
      setKey(newKey());
    };
    element.addEventListener('close', onClose);
    return () => element.removeEventListener('close', onClose);
  }, []);

  async function confirm() {
    setBusy(true);
    setProblem(null);
    // A guest session is created on the first copy: no account, $1,000 of test money.
    if (!me) {
      const session = await post<MeResponse>('/api/session', {});
      if (!session.ok) {
        setProblem(session.error.message);
        setBusy(false);
        return;
      }
    }
    const result = await post<CopyResponse>(`/api/theses/${thesis.id}/copy`, {
      amountUsd: amountNumber,
      tipUsdc: thesis.tipsOpen ? Number(tip) : 0,
      idempotencyKey: key,
    });
    setBusy(false);
    reloadMe();
    if (result.ok) {
      setDone(result.data);
      return;
    }
    if (result.error.code === 'price_moved' && result.error.price) {
      // Show the new price and ask again, with a fresh key for the new attempt.
      setNewPrice(result.error.price);
      setKey(newKey());
      setProblem(
        `The price moved to ${cents(result.error.price)}. Check the numbers below and confirm again if you still want it.`,
      );
      return;
    }
    setProblem(result.error.message);
  }

  if (compact && viewerIsAuthor) return <span className="text-[13px] text-muted-foreground">Your thesis</span>;

  return (
    <div className={compact ? undefined : 'space-y-1.5'}>
      {compact ? (
        <Button
          variant={blocked ? 'secondary' : 'default'}
          className="h-9 px-4 text-sm disabled:opacity-100 disabled:text-muted-foreground"
          disabled={blocked !== null}
          title={blocked ?? undefined}
          aria-label={blocked ? `Copy trade: ${blocked}` : 'Copy trade'}
          onClick={() => dialog.current?.showModal()}
        >
          {blocked ? shortReason(blocked) : 'Copy trade'}
        </Button>
      ) : (
        <Button
          size="lg"
          className={cn('h-10 px-5', wide && 'w-full')}
          disabled={blocked !== null}
          onClick={() => dialog.current?.showModal()}
        >
          Copy trade
        </Button>
      )}
      {blocked && !compact && <p className="text-sm text-muted-foreground">{blocked}</p>}

      <dialog
        ref={dialog}
        aria-labelledby="copy-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-5 text-left text-foreground backdrop:bg-black/60"
      >
        {done ? (
          <div className="space-y-3">
            <h2 id="copy-title" className="text-lg font-semibold">
              Bought
            </h2>
            <p className="text-sm">
              {contracts(done.trade.quantity)} {done.trade.side.toUpperCase()} at {cents(done.trade.price)} for{' '}
              {usd(done.trade.costUsd)}. It pays {usd(done.payoutIfRightUsd)} if the thesis is right and nothing if
              it is wrong.
            </p>
            <p className="text-sm text-muted-foreground">
              The position is locked until the market resolves. Simulated fill at Gemini’s live price, with test
              money.
            </p>
            {done.tip.id && <TipProgress tipId={done.tip.id} amountUsdc={done.tip.amountUsdc} />}
            {done.tip.status === 'failed' && !done.tip.id && (
              <p role="alert" className="rounded-lg border p-3 text-sm">
                Your tip could not be recorded, and nothing was taken. Your trade is unaffected.
              </p>
            )}
            <Button onClick={() => dialog.current?.close()}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <h2 id="copy-title" className="text-lg font-semibold leading-snug">
              Buy {thesis.side.toUpperCase()} on “{thesis.market.title}
              {thesis.market.contractLabel ? `, ${thesis.market.contractLabel}` : ''}” at about {cents(price)}
            </h2>

            <div className="space-y-1.5">
              <label htmlFor="copy-amount" className="block text-sm font-medium">
                Amount, in dollars of test money
              </label>
              <input
                id="copy-amount"
                type="number"
                inputMode="decimal"
                min={0.01}
                max={cap}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-32 rounded-lg border border-input bg-background px-3 py-2 text-base tabular-nums"
              />
              <p className="text-sm tabular-nums text-muted-foreground">
                Up to {usd(cap)} a trade. {usd(leftToday)} of your daily copy limit is left.
              </p>
            </div>

            {thesis.tipsOpen && (
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Tip for the author, in test USDC</legend>
                <div className="flex flex-wrap gap-2">
                  {TIP_CHOICES_USDC.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={tip === choice}
                      onClick={() => setTip(choice)}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-sm font-medium tabular-nums',
                        tip === choice ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {choice === '0' ? 'None' : choice}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="rounded-lg border p-3 text-sm tabular-nums">
              {quantity > 0 ? (
                <>
                  <p>
                    {usd(amountNumber)} buys {quantity} contracts.
                  </p>
                  <p className="font-medium">
                    Most you can lose: {usd(cost)}. If right you receive {usd(quantity)}.
                  </p>
                </>
              ) : (
                <p>Enter an amount to see what it buys.</p>
              )}
              {thesis.tipsOpen && (
                <p className="mt-1 text-muted-foreground">
                  The tip goes to the author only if the thesis is right. If it is wrong, the tip comes back to you.
                </p>
              )}
            </div>

            <p className="text-sm text-muted-foreground">
              Simulated fill at Gemini’s live price. The author bought at {cents(thesis.entryPrice)}; the trade is
              refused if the price has moved more than 5 cents above that.
              {thesis.tipsOpen
                ? ' The tip is test USDC held by a contract on Arc testnet until the market resolves.'
                : ' This thesis is not recorded on-chain, so it cannot take a tip.'}
            </p>

            {problem && (
              <p role="alert" className="rounded-lg border border-no p-3 text-sm">
                {problem}
              </p>
            )}

            <div className="flex gap-2">
              <Button disabled={!ready || busy} onClick={confirm}>
                {busy ? 'Placing the trade' : 'Confirm'}
              </Button>
              <Button variant="outline" onClick={() => dialog.current?.close()}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
