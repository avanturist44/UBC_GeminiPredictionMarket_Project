'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AccountView } from '@thesis/services';
import { useLive } from '@/lib/use-live';
const tx=(hash:string|null)=>hash&&/^0x[0-9a-f]{64}$/i.test(hash)?`https://explorer.testnet.arc.io/tx/${hash}`:null;
async function write(url:string,body:unknown,method='POST') {
  const response=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json(); if(!response.ok) throw new Error(data.message??'Request failed.'); return data;
}
function WalletBalance() {
  const {data,error,retry}=useLive<{balanceUsdc:string;allowanceUsdc:string}>('/api/me/wallet',undefined);
  return <>{data&&<p>On-chain balance: {data.balanceUsdc} test USDC · Escrow allowance: {data.allowanceUsdc}. Pending tips reserve part of this balance.</p>}{error&&<p role="alert">Test balance could not be refreshed. <button onClick={retry} className="underline">Retry balance</button></p>}</>;
}
function LimitsForm({account,onSaved}:{account:AccountView;onSaved:()=>void}) {
  const [trade,setTrade]=useState(String(Number(account.pendingLimits?.maxPerTradeUsd??account.maxPerTradeUsd)));
  const [daily,setDaily]=useState(String(Number(account.pendingLimits?.dailyCapUsd??account.dailyCapUsd)));
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  return <form className="space-y-3 rounded-xl border p-4" onSubmit={async event=>{event.preventDefault();setBusy(true);setMessage('');try{const result=await write('/api/me/limits',{maxPerTradeUsd:trade,dailyCapUsd:daily},'PATCH');setMessage(result.effectiveAt?'Lower caps applied. Any increases start next UTC day.':'Your caps are applied.');onSaved();}catch(error){setMessage(error instanceof Error?error.message:'Could not save limits.');}finally{setBusy(false);}}}>
    <h2 className="font-semibold">Your paper limits</h2><p className="text-sm">Active: ${account.maxPerTradeUsd} per trade · ${account.dailyCapUsd} per UTC day.</p>
    {account.pendingLimits&&<p className="text-sm" role="status">Scheduled for {new Date(account.pendingLimits.effectiveAt).toLocaleString('en-US',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})} UTC: {account.pendingLimits.maxPerTradeUsd?`$${account.pendingLimits.maxPerTradeUsd} per trade. `:''}{account.pendingLimits.dailyCapUsd?`$${account.pendingLimits.dailyCapUsd} per day.`:''}</p>}
    <p className="text-sm text-muted-foreground">Lowering applies immediately. Increases start at the next 00:00 UTC. Hard ceilings remain $10 per trade and $25 per day. Saving the active amounts cancels scheduled increases.</p>
    <label className="block text-sm">Maximum per trade ($)<input type="number" min="1" max="10" step="0.01" required value={trade} onChange={e=>setTrade(e.target.value)} className="mt-1 block w-full rounded-lg border p-2"/></label>
    <label className="block text-sm">Daily cap ($)<input type="number" min="1" max="25" step="0.01" required value={daily} onChange={e=>setDaily(e.target.value)} className="mt-1 block w-full rounded-lg border p-2"/></label>
    <button disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">{busy?'Saving…':'Save paper limits'}</button>{message&&<p role="status" className="text-sm">{message}</p>}
  </form>;
}
export function Account() {
  const {data,error,retry}=useLive<AccountView>('/api/me',undefined);
  const needsSession=error?.code==='session_required';
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  return <div className="space-y-5 [overflow-wrap:anywhere]"><h1 className="text-2xl font-semibold">My account</h1>
    {!data&&!error&&<p role="status">Loading your account…</p>}
    {needsSession&&<><p className="text-sm">Your guest session keeps your paper trades, theses and test-USDC tips together in this browser. It lasts seven days. Clearing the session loses account access; no account recovery is available.</p>
      <form className="space-y-3 rounded-xl border p-4" onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage('');try{await write('/api/session',{displayName:name});retry();}catch(err){setMessage(err instanceof Error?err.message:'Session unavailable.');}finally{setBusy(false);}}}>
      <label className="block text-sm">Display name<input required minLength={2} maxLength={40} value={name} onChange={e=>setName(e.target.value)} className="mt-1 block w-full rounded-lg border p-2"/></label><button disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm text-white">Start guest session</button>{message&&<p role="alert">{message}</p>}</form></>}
    {error&&!needsSession&&<p role="alert" className="text-sm">{error.message} <button className="underline" onClick={retry}>Retry account</button></p>}
    {data&&!needsSession&&<><p className="font-medium">{data.displayName} · Paper mode</p><section className="grid gap-3 sm:grid-cols-3" aria-label="Paper balances">{[['Available simulated balance',data.paperBalanceUsd],['Spent today (UTC)',data.spentTodayUsd],['Remaining daily allowance',data.remainingTodayUsd]].map(([label,value])=><div key={label} className="rounded-xl border p-4 text-sm"><p className="text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">${value}</p></div>)}</section>
      <section className="space-y-2 rounded-xl border p-4 text-sm"><h2 className="font-semibold">Arc test wallet</h2>{data.wallet?<><p>Status: {data.wallet.status}</p><p>{data.wallet.address}</p><WalletBalance/><p>Test USDC is separate from your simulated balance. The server controls this Circle wallet.</p></>:<p>No test wallet prepared. You can prepare one in a copy confirmation, or copy without a tip.</p>}</section>
      <LimitsForm key={JSON.stringify([data.maxPerTradeUsd,data.dailyCapUsd,data.pendingLimits])} account={data} onSaved={retry}/>
      <section className="space-y-3"><h2 className="text-lg font-semibold">Your theses</h2>{!data.theses.length&&<p className="text-sm text-muted-foreground">No submissions yet. <Link href="/write" className="text-primary underline">Write a thesis</Link>.</p>}{data.theses.map(t=><p key={t.id} className="rounded-lg border p-3 text-sm"><Link href={`/thesis/${t.id}`} className="text-primary underline">{t.headline}</Link> · {t.status}{t.outcome?` · ${t.outcome}`:''}</p>)}</section>
      <section className="space-y-3"><h2 className="text-lg font-semibold">Paper positions</h2><p className="text-xs text-muted-foreground">Most recent 50. Positions stay locked until official resolution.</p>{!data.positions.length&&<p className="text-sm">No paper positions yet. <Link href="/" className="text-primary underline">Explore theses</Link>.</p>}{data.positions.map(p=><article key={p.id} className="space-y-1 rounded-lg border p-3 text-sm"><p>{p.thesisId?<Link href={`/thesis/${p.thesisId}`} className="text-primary underline">{p.title}</Link>:p.title}</p><p>{p.side.toUpperCase()} · {p.quantity} contracts · ${p.costUsd} simulated cost · {p.status}</p>{p.payoutUsd!==null&&<p>Official payout: ${p.payoutUsd} simulated.</p>}</article>)}</section>
      <section className="space-y-3"><h2 className="text-lg font-semibold">Test-USDC tips</h2><p className="text-xs text-muted-foreground">Most recent 50. A failed tip does not reverse its paper position.</p>{!data.tips.length&&<p className="text-sm">No tips requested yet.</p>}{data.tips.map(t=><article key={t.id} className="space-y-2 rounded-lg border p-3 text-sm"><Link href={`/thesis/${t.thesisId}`} className="text-primary underline">{t.headline}</Link><p>{t.amountUsdc} test USDC · {t.status}</p>{tx(t.depositTx)&&<a href={tx(t.depositTx)!} target="_blank" rel="noopener noreferrer" className="mr-3 text-primary underline">Deposit ↗</a>}{tx(t.settleTx)&&<a href={tx(t.settleTx)!} target="_blank" rel="noopener noreferrer" className="text-primary underline">Payout or refund ↗</a>}</article>)}</section>
    </>}
  </div>;
}
