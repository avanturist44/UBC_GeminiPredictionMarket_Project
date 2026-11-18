'use client';

import { BODY_MAX, EVIDENCE_MAX, HEADLINE_MAX, checkSideAgainstPrice } from '@thesis/core/browser';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ThesisCard } from '@/components/thesis-card';
import { Button } from '@/components/ui/button';
import { cents, noBuyPrice, usd } from '@/lib/format';
import type { ApiError, MarketView, MarketsResponse } from '@/lib/market-view';
import type { MeResponse, SubmitResponse, ThesisCardView } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The thesis editor. It shows the format's rules as the author writes, but every rule is
 * checked again on the server: this form decides nothing.
 */

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-base';
const label = 'block text-sm font-medium';
const hint = 'text-sm text-muted-foreground';

async function send<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((json as Partial<ApiError> | null)?.message ?? `The request failed (${response.status}).`);
  }
  return json as T;
}

export function ThesisEditor({
  markets: initialMarkets,
  me,
  initialSymbol,
}: {
  markets: MarketsResponse | undefined;
  me: MeResponse | null;
  initialSymbol: string | undefined;
}) {
  const router = useRouter();
  const { data } = useLive<MarketsResponse>('/api/markets', initialMarkets, 5000);
  const { now } = useNow(initialMarkets?.asOf);
  const markets = data?.markets ?? [];

  const [symbol, setSymbol] = useState(initialSymbol ?? '');
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [probability, setProbability] = useState(60);
  const [stake, setStake] = useState('5');
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [evidence, setEvidence] = useState([{ claim: '', url: '' }]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const market: MarketView | undefined = markets.find((m) => m.symbol === symbol);
  const sideCheck = market
    ? checkSideAgainstPrice({ side, probabilityYes: probability / 100, yesBid: market.yesBid, yesAsk: market.yesAsk })
    : null;
  const price = market ? (side === 'yes' ? market.yesAsk : noBuyPrice(market.yesBid)) : null;
  const maxStake = Number(me?.maxPerTradeUsd ?? 10);
  const stakeNumber = Number(stake);
  const buys = price !== null && stakeNumber > 0 ? Math.floor((stakeNumber / Number(price)) * 100) / 100 : null;

  const setRow = (index: number, patch: Partial<{ claim: string; url: string }>) =>
    setEvidence((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      if (!me) await send<MeResponse>('/api/session', name.trim() ? { displayName: name.trim() } : {});
      const created = await send<SubmitResponse>('/api/theses', {
        symbol,
        side,
        probabilityYes: probability / 100,
        stakeUsd: stakeNumber,
        headline,
        body,
        evidence: evidence.filter((row) => row.claim.trim() || row.url.trim()),
      });
      // The thesis page shows the audit running, then the published thesis or why it was blocked.
      router.push(`/thesis/${created.id}`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The thesis could not be submitted.');
      setBusy(false);
    }
  }

  const preview: ThesisCardView | null = market
    ? {
        id: 'preview',
        status: 'published',
        outcome: null,
        publishedAt: null,
        author: {
          id: 'preview',
          name: me?.displayName ?? (name.trim() || 'You'),
          kind: 'human',
          agentKey: null,
          record: { resolved: 0, right: 0, brier: null, marketBrier: null },
        },
        market: {
          symbol: market.symbol,
          title: market.title,
          contractLabel: market.contractLabel,
          expiryAt: market.expiryAt,
          marketState: market.marketState,
          resolutionSide: null,
        },
        side,
        probabilityYes: probability / 100,
        headline: headline || 'Your headline',
        body: body || 'Your argument appears here.',
        entryPrice: price === null ? null : String(price),
        currentPrice: price === null ? null : String(price),
        audit: null,
        position: null,
        tipsUsdc: '0',
      }
    : null;

  return (
    <form onSubmit={submit} className="space-y-6">
      <p className="rounded-lg border p-4 text-sm">
        Argue from public evidence. Theses claiming inside information are not published. Every
        thesis is audited before it goes up, and you take the position you argue for: it is locked
        until the market resolves.
      </p>

      {!me && (
        <div className="space-y-1.5">
          <label htmlFor="name" className={label}>
            Your name, as shown on the thesis
          </label>
          <input id="name" className={field} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave blank to post as a guest" />
          <p className={hint}>No account needed. You start with $1,000 of test money.</p>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="market" className={label}>
          Market
        </label>
        <select id="market" className={field} value={symbol} onChange={(e) => setSymbol(e.target.value)} required>
          <option value="">Choose a market</option>
          {markets.map((m) => (
            <option key={m.symbol} value={m.symbol}>
              {m.title}
              {m.contractLabel ? `, ${m.contractLabel}` : ''}
            </option>
          ))}
        </select>
        {market && (
          <p className={cn(hint, 'tabular-nums')}>
            Buying YES costs {cents(market.yesAsk)} and buying NO costs {cents(noBuyPrice(market.yesBid))} right now.
          </p>
        )}
      </div>

      <fieldset className="space-y-1.5">
        <legend className={label}>Side</legend>
        <div className="flex gap-2">
          {(['yes', 'no'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={side === option}
              onClick={() => setSide(option)}
              className={cn(
                'rounded-md border px-4 py-2 text-sm font-semibold',
                side === option
                  ? option === 'yes'
                    ? 'border-yes bg-yes text-white'
                    : 'border-no bg-no text-white'
                  : 'border-input text-muted-foreground',
              )}
            >
              {option.toUpperCase()}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="probability" className={label}>
          Your probability that this resolves YES: <span className="tabular-nums">{probability}%</span>
        </label>
        <input id="probability" type="range" min={1} max={99} step={1} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-primary" />
        {sideCheck && !sideCheck.ok && (
          <p role="alert" className="text-sm text-no">
            {sideCheck.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="stake" className={label}>
          Your stake, in dollars of test money
        </label>
        <input id="stake" type="number" inputMode="decimal" min={1} max={maxStake} step="0.01" className={cn(field, 'max-w-40 tabular-nums')} value={stake} onChange={(e) => setStake(e.target.value)} required />
        <p className={cn(hint, 'tabular-nums')}>
          Between $1 and {usd(maxStake)}.
          {buys !== null && price !== null && buys > 0 && (
            <>
              {' '}
              At {cents(price)} that buys about {buys} contracts. Most you can lose: {usd(buys * Number(price))}. If you
              are right you receive {usd(buys)}.
            </>
          )}
          {me && <> Your paper balance is {usd(me.paperBalanceUsd)}.</>}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="headline" className={label}>
          Headline
        </label>
        <input id="headline" className={field} maxLength={HEADLINE_MAX} value={headline} onChange={(e) => setHeadline(e.target.value)} required />
        <p className={cn(hint, 'tabular-nums')}>
          {headline.length} of {HEADLINE_MAX} characters
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="body" className={label}>
          Your thesis
        </label>
        <textarea id="body" className={cn(field, 'min-h-40')} maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} required />
        <p className={cn(hint, 'tabular-nums')}>
          {body.length} of {BODY_MAX} characters. State the facts your view rests on: the auditor checks them.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className={label}>Sources</legend>
        {evidence.map((row, index) => (
          <div key={index} className="space-y-1.5">
            <input aria-label={`Source ${index + 1}: what it shows`} className={field} maxLength={200} value={row.claim} onChange={(e) => setRow(index, { claim: e.target.value })} placeholder="What this source shows" required={index === 0} />
            <div className="flex gap-2">
              <input aria-label={`Source ${index + 1}: web address`} type="url" className={field} maxLength={500} value={row.url} onChange={(e) => setRow(index, { url: e.target.value })} placeholder="https://" required={index === 0} />
              {evidence.length > 1 && (
                <Button type="button" variant="outline" onClick={() => setEvidence((rows) => rows.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
        {evidence.length < EVIDENCE_MAX && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEvidence((rows) => [...rows, { claim: '', url: '' }])}>
            Add another source
          </Button>
        )}
      </fieldset>

      {preview && (
        <section aria-labelledby="preview-heading" className="space-y-1">
          <h2 id="preview-heading" className="text-sm font-medium text-muted-foreground">
            How it will look in the feed
          </h2>
          <div className="border-y">
            <ThesisCard thesis={preview} now={now} linked={false} />
          </div>
        </section>
      )}

      {problem && (
        <p role="alert" className="rounded-lg border border-no p-3 text-sm">
          {problem}
        </p>
      )}

      <div className="space-y-2">
        <Button type="submit" size="lg" disabled={busy || !market || (sideCheck !== null && !sideCheck.ok)}>
          {busy ? 'Sending to the auditor' : 'Send for audit and publish'}
        </Button>
        <p className={hint}>
          Your position is bought only if the audit does not block the thesis. Simulated fill at
          Gemini’s live price, with test money.
        </p>
      </div>
    </form>
  );
}
