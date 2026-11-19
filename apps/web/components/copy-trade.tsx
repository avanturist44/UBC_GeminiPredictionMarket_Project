'use client';
import { useEffect, useRef, useState } from 'react';
import type { getCopy, quoteCopy, ThesisView } from '@thesis/services';
import { useLive } from '@/lib/use-live';
type Quote = Awaited<ReturnType<typeof quoteCopy>>;
type Receipt = NonNullable<Awaited<ReturnType<typeof getCopy>>>;
type Wallet = { status: string; address: string | null; balanceUsdc: string; allowanceUsdc: string; errorCode: string | null };
const txLink = (value: string | null) => value && /^0x[a-f0-9]{64}$/i.test(value) ? `https://explorer.testnet.arc.io/tx/${value}` : null;
async function send(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'This request could not be completed.'); return result;
}
function CopyReceipt({ initial }: { initial: Receipt }) {
  const { data, error, retry } = useLive<Receipt>(`/api/copies/${initial.id}`, initial);
  const receipt = data ?? initial;
  const deposit = txLink(receipt.tip?.depositTx ?? null), settlement = txLink(receipt.tip?.settleTx ?? null);
  return <div className="space-y-4" aria-live="polite">
    <h3 className="text-xl font-semibold">Paper trade filled</h3>
    <p className="text-sm">Bought {receipt.trade.quantity} {receipt.trade.side.toUpperCase()} contracts at ${receipt.trade.price}. Cost: <strong>${receipt.trade.costUsd} simulated</strong>.</p>
    <p className="text-sm">{receipt.trade.status === 'settled' ? `Official settlement payout: $${receipt.trade.payoutUsd} simulated.` : 'Your position is locked until official Gemini resolution.'}</p>
    {receipt.tip ? <section className="space-y-2 rounded-xl border p-4 text-sm"><p>Tip: {receipt.tip.amountUsdc} test USDC · <strong className="capitalize">{receipt.tip.status}</strong></p>
      <p className="text-muted-foreground">{receipt.tip.status === 'pending' ? 'Waiting for Circle and the on-chain deposit.' : receipt.tip.status === 'escrowed' ? 'Held in escrow. The author receives it if correct; otherwise it is refunded.' : receipt.tip.status === 'failed' ? 'The tip transaction failed. Your paper trade remains filled.' : receipt.tip.status === 'paid' ? 'The author was correct and received the escrowed tip.' : 'The tip was refunded to your test wallet.'}</p>
      {deposit && <a href={deposit} target="_blank" rel="noopener noreferrer" className="block text-primary underline">View escrow deposit ↗</a>}
      {settlement && <a href={settlement} target="_blank" rel="noopener noreferrer" className="block text-primary underline">View payout or refund ↗</a>}
    </section> : <p className="text-sm">No tip was requested. No USDC deposit was made.</p>}
    {error && <p role="alert" className="text-sm">{error.message} <button className="underline" onClick={retry}>Retry status</button></p>}
  </div>;
}
function CopyForm({ thesis, onBusy }: { thesis: ThesisView; onBusy: (value: boolean) => void }) {
  const [amount, setAmount] = useState('5'), [tip, setTip] = useState('0.10');
  const [quote, setQuote] = useState<Quote | null>(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const id = useRef(crypto.randomUUID());
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => {
    const saved = localStorage.getItem(`thesis-copy:${thesis.id}`);
    if (saved) fetch(`/api/copies/${saved}`, { cache: 'no-store' }).then(async response => {
      if (response.ok) setReceipt(await response.json() as Receipt);
    }).catch(() => {});
  }, [thesis.id]);
  const { data: wallet, error: walletError, retry: retryWallet } = useLive<Wallet>('/api/me/wallet', undefined);
  const refresh = () => { setQuote(null); setAcknowledged(false); id.current = crypto.randomUUID(); setMessage(''); };
  async function review() {
    setBusy(true); setMessage('');
    try { setQuote(await send(`/api/theses/${thesis.id}/quote`, { amountUsd: amount, tipUsdc: tip })); setAcknowledged(false); }
    catch (error) { setQuote(null); setMessage(error instanceof Error ? error.message : 'Quote unavailable.'); }
    finally { setBusy(false); }
  }
  async function prepareWallet() {
    setBusy(true); setMessage('');
    try { await send('/api/me/wallet', {}); retryWallet(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Wallet setup unavailable.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!quote || busy) return; setBusy(true); setMessage('');
    try { const filled = await send(`/api/theses/${thesis.id}/copy`, { idempotencyKey: id.current, amountUsd: amount, tipUsdc: tip,
      quoteToken: quote.quoteToken, acceptPriceMoved: acknowledged });
      setReceipt(filled); localStorage.setItem(`thesis-copy:${thesis.id}`, filled.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Confirmation unavailable.'); }
    finally { setBusy(false); }
  }
  if (receipt) return <><CopyReceipt initial={receipt} /><button type="button" className="text-sm text-primary underline" onClick={() => {
    localStorage.removeItem(`thesis-copy:${thesis.id}`); setReceipt(null); setQuote(null); id.current = crypto.randomUUID();
  }}>Review another copy</button></>;
  return <div className="space-y-4">
    <p className="text-sm">Buy <strong>{thesis.side.toUpperCase()}</strong> on “{thesis.market.title}”.</p>
    <label className="block space-y-1 text-sm font-medium"><span>Paper amount ($)</span><input aria-label="Paper amount ($)" type="number" min={1} max={10} step={0.01} value={amount} disabled={busy} onChange={event => { setAmount(event.target.value); refresh(); }} className="w-full rounded-lg border px-3 py-2" /></label>
    <label className="block space-y-1 text-sm font-medium"><span>Test USDC tip</span><select aria-label="Test USDC tip" value={tip} disabled={busy} onChange={event => { setTip(event.target.value); refresh(); }} className="w-full rounded-lg border bg-background px-3 py-2"><option value="0">None</option><option value="0.10">0.10</option><option value="0.25">0.25</option><option value="0.50">0.50</option></select></label>
    {Number(tip) > 0 && <section className="space-y-2 rounded-lg border p-3 text-sm">
      <p>Test wallet: <strong>{wallet?.status.replace('_', ' ') ?? 'loading'}</strong>{wallet?.address ? ` · ${Number(wallet.balanceUsdc).toFixed(4)} USDC available` : ''}</p>
      {wallet && wallet.status === 'not_created' && <><p className="text-muted-foreground">Create a Circle-managed test wallet with 2 test USDC. The app handles signing and network fees.</p><button type="button" disabled={busy} onClick={prepareWallet} className="text-primary underline">Prepare test wallet</button></>}
      {wallet && ['queued', 'funding', 'approving'].includes(wallet.status) && <p role="status">Preparing your wallet and escrow allowance. Updates automatically.</p>}
      {wallet?.status === 'failed' && <p role="alert">Wallet setup failed. You can select no tip to continue with paper trading.</p>}
      {walletError && <p role="alert">{walletError.message} <button className="underline" onClick={retryWallet}>Retry wallet status</button></p>}
    </section>}
    <button type="button" disabled={busy} onClick={review} className="rounded-full border px-4 py-2 text-sm font-medium disabled:opacity-50">{busy ? 'Working…' : quote ? 'Refresh live quote' : 'Review live quote'}</button>
    {quote && <section className="space-y-3 rounded-xl bg-muted p-4 text-sm" aria-label="Copy confirmation">
      <p>{quote.quantity} contracts at ${quote.price}.</p>
      <p>Most you can lose: <strong>${quote.maxPaperLossUsd} simulated</strong>.</p>
      <p>If right, you receive ${quote.winningPayoutUsd} simulated.</p>
      <p>Daily paper allowance before this copy: ${quote.remainingDailyUsd}.</p>
      <p>Tip: {quote.tipUsdc} test USDC{Number(tip) > 0 ? ', plus network fees in test USDC.' : '.'}</p>
      <p>Simulated fill at Gemini’s live price. Tips move on Arc testnet.</p>
      {quote.priceMoved && <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>The price is more than 5¢ above the author’s entry. I accept this quoted price.</span></label>}
      <button type="button" onClick={confirm} disabled={busy || (quote.priceMoved && !acknowledged) || (Number(tip) > 0 && wallet?.status !== 'ready')}
        className="rounded-full bg-primary px-4 py-2 font-medium text-white disabled:opacity-50">Confirm copy trade</button>
    </section>}
    {message && <p role="alert" className="rounded-lg border p-3 text-sm">{message}</p>}
    <p className="text-xs text-muted-foreground">The server manages your test wallet and reports Gemini’s official outcome. A failed tip never reverses a paper fill. Unresolved escrow tips become refundable seven days after expiry.</p>
  </div>;
}
function CopyDialog({ thesis, close }: { thesis: ThesisView; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    let active = true;
    (async () => { const me = await fetch('/api/me', { cache: 'no-store' });
      if (me.status === 401) await send('/api/session', { displayName: 'Guest copier' });
      else if (!me.ok) throw new Error('Your session could not be loaded.');
      if (active) setReady(true);
    })().catch(() => { if (active) setError('A guest session could not be prepared. Close and try again.'); });
    return () => { active = false; };
  }, []);
  return <dialog ref={ref} onCancel={event => { if (locked) event.preventDefault(); else close(); }} aria-labelledby="copy-title" className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md space-y-4 overflow-y-auto rounded-xl border bg-background p-5 backdrop:bg-black/40 [overflow-wrap:anywhere]">
    <div className="flex items-center justify-between gap-3"><h2 id="copy-title" className="text-xl font-semibold">Copy this trade</h2><button type="button" aria-label="Close copy dialog" onClick={close} disabled={locked} className="rounded px-2 py-1 disabled:opacity-50">✕</button></div>
    {ready ? <CopyForm thesis={thesis} onBusy={setLocked} /> : error ? <p role="alert">{error}</p> : <p role="status">Preparing your guest session…</p>}
  </dialog>;
}
export function CopyTrade({ thesis }: { thesis: ThesisView }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white">Copy trade</button>{open && <CopyDialog thesis={thesis} close={() => setOpen(false)} />}</>;
}
