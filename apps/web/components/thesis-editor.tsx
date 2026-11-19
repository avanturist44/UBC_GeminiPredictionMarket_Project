'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLive } from '@/lib/use-live';
import type { MarketsResponse } from '@/lib/market-view';
type Guest = { displayName: string; paperBalanceUsd: string; maxPerTradeUsd: string; dailyCapUsd: string };
export function ThesisEditor() {
  const router = useRouter();
  const { data, error, retry } = useLive<MarketsResponse>('/api/markets', undefined);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = useRef<string | null>(null);
  useEffect(() => { fetch('/api/me', { cache: 'no-store' }).then(async response => { if (response.ok) setGuest(await response.json() as Guest); }).catch(() => {}); }, []);
  async function send(url: string, body: unknown) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? 'The request could not be completed.');
    return result;
  }
  async function submit(form: FormData) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (!guest) await send('/api/session', { displayName: form.get('displayName') });
      key.current ??= crypto.randomUUID();
      const result = await send('/api/theses', { idempotencyKey: key.current, symbol: form.get('symbol'), headline: form.get('headline'), body: form.get('body'), side: form.get('side'), probabilityYes: Number(form.get('probability')) / 100, stakeUsd: String(form.get('stake')), evidence: [{ claim: form.get('claim'), url: form.get('source') }] });
      router.push(`/thesis/${result.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Publication is unavailable.'); setBusy(false); }
  }
  const field = 'w-full rounded-lg border bg-background px-3 py-2 text-sm';
  return <div className="space-y-5">
    <h1 className="text-3xl font-semibold tracking-tight">Put your reasoning on the record.</h1>
    <p className="text-muted-foreground">Write a thesis, cite public evidence and choose a paper stake. We audit it before a simulated fill and publication.</p>
    <p className="rounded-xl border p-4 text-sm">{guest ? `${guest.displayName} · $${Number(guest.paperBalanceUsd).toFixed(2)} paper balance · $${Number(guest.maxPerTradeUsd)} per trade · $${Number(guest.dailyCapUsd)} daily spending cap.` : 'A guest session starts with $1,000 simulated dollars. Maximum $10 per trade and $25 total paper spending per UTC day.'} Positions are held to official resolution. No USDC is used.</p>
    {error && <p role="alert">{error.message} <button className="underline" onClick={retry}>Retry</button></p>}
    <form action={submit} className="space-y-4" onChange={() => { if (!busy) key.current = null; }}><fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
      {!guest && <label className="block space-y-1 text-sm font-medium"><span>Display name</span><input name="displayName" required minLength={2} maxLength={40} autoComplete="nickname" className={field} /></label>}
      <label className="block space-y-1 text-sm font-medium"><span>Market</span><select name="symbol" aria-label="Market" required className={field} defaultValue=""><option value="" disabled>Choose a live market</option>{data?.markets.filter(m => m.marketState === 'open' && m.expiryAt && new Date(m.expiryAt).getTime() - Date.now() > 180_000).map(m => <option key={m.symbol} value={m.symbol}>{m.title} · YES {m.yesAsk ? `${(Number(m.yesAsk) * 100).toFixed(0)}¢` : 'unavailable'}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><label className="space-y-1 text-sm font-medium"><span>Side</span><select name="side" className={field}><option value="yes">YES</option><option value="no">NO</option></select></label><label className="space-y-1 text-sm font-medium"><span>Forecast YES (%)</span><input name="probability" type="number" min={0} max={100} step={1} defaultValue={65} required className={field} /></label><label className="space-y-1 text-sm font-medium"><span>Paper stake ($)</span><input name="stake" type="number" min={1} max={10} step={0.01} defaultValue={5} required className={field} /></label></div>
      <label className="block space-y-1 text-sm font-medium"><span>Headline</span><input name="headline" aria-label="Headline" required minLength={5} maxLength={90} className={field} /><span className="text-xs font-normal text-muted-foreground">Up to 90 characters.</span></label>
      <label className="block space-y-1 text-sm font-medium"><span>Your reasoning</span><textarea name="body" aria-label="Your reasoning" required minLength={20} maxLength={1200} rows={6} className={field} /><span className="text-xs font-normal text-muted-foreground">Use public information. Separate facts from your forecast. Up to 1,200 characters.</span></label>
      <label className="block space-y-1 text-sm font-medium"><span>What does your source support?</span><input name="claim" required maxLength={500} className={field} /></label>
      <label className="block space-y-1 text-sm font-medium"><span>Public source URL</span><input name="source" type="url" required maxLength={2048} placeholder="https://…" className={field} /></label>
      <p className="text-xs text-muted-foreground">If filled, up to your stake can be lost. A flagged thesis can publish with its warnings; a blocked thesis cannot trade. Fresh quotes, available size and account limits determine the final fill.</p>
      <button type="submit" disabled={!data?.markets.length} className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Submitting…' : 'Audit & place paper trade'}</button>
    </fieldset>{message && <p role="alert" className="rounded-lg border p-3 text-sm">{message}</p>}</form>
  </div>;
}
