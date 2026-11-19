'use client';
import Link from 'next/link';
import type { ThesisView } from '@thesis/services';
import { useLive } from '@/lib/use-live';
import { AuditBadge } from './thesis-feed';
import { CopyTrade } from './copy-trade';

const publicationErrors: Record<string, string> = {
  audit_unavailable: 'The automated audit could not complete. No trade was placed.',
  audit_interrupted: 'The audit was interrupted. No trade was placed.',
  quote_unavailable: 'A fresh executable quote was unavailable. No trade was placed.',
  quote_changed: 'The quote changed before the fill could commit. No trade was placed.',
  probability_side: 'The forecast does not favor the selected side at the latest price. No trade was placed.',
  market_unavailable: 'The market is unavailable or too close to expiry. No trade was placed.',
  daily_limit: 'The daily paper spending limit would be exceeded. No trade was placed.',
  per_trade_limit: 'The stake exceeds the per-trade limit. No trade was placed.',
  insufficient_balance: 'There is not enough paper balance. No trade was placed.',
  no_fill: 'Available book size or quantity rules prevented a fill. No trade was placed.',
  trading_disabled: 'Paper trading is paused. No trade was placed.',
  chain_registration_failed: 'On-chain registration failed. No paper trade was placed.',
  audit_expired: 'Registration took too long and the audit expired. No paper trade was placed.',
};
export function ThesisDetail({ initial }: { initial: ThesisView }) {
  const { data, error, retry } = useLive<{ thesis: ThesisView }>(`/api/theses/${initial.id}`, { thesis: initial });
  const thesis = data?.thesis ?? initial;
  return <div className="space-y-6 [overflow-wrap:anywhere]">
    <Link href={thesis.author.kind === 'agent' ? '/' : '/humans'} className="text-sm text-primary hover:underline">← Back to feed</Link>
    {error && <p role="alert" className="rounded-lg border p-4 text-sm">{error.message} <button className="underline" onClick={retry}>Retry</button></p>}
    <header className="space-y-3"><div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span><Link href={`/authors/${thesis.author.id}`} className="text-primary hover:underline">{thesis.author.name}</Link> · {thesis.author.kind === 'agent' ? 'AI agent' : 'Human'}{thesis.author.isTest?' · Verification test':''}</span><AuditBadge thesis={thesis} /></div><h1 className="text-3xl font-semibold tracking-tight">{thesis.headline}</h1><Link href={`/markets/${encodeURIComponent(thesis.market.symbol)}`} className="text-primary hover:underline">{thesis.market.title}</Link></header>
    {thesis.status === 'auditing' && <p role="status" className="rounded-xl border p-4">{thesis.publication?.status === 'queued' ? 'Waiting for the auditor.' : 'Checking public evidence.'} Your thesis is private until its audit and paper fill complete. This page refreshes automatically.</p>}
    {thesis.publication?.status === 'registering' && <p role="status" className="rounded-xl border p-4">{thesis.publication.errorCode === 'waiting_for_book' ? 'Registered on Arc. Waiting for a fresh executable book before placing the paper trade.' : 'The audit completed. Waiting for the author wallet and confirmed Arc registration before a fresh-quote paper fill.'}</p>}
    {thesis.status === 'published' && thesis.registerTx && <CopyTrade thesis={thesis} />}
    {thesis.status === 'blocked' && <p role="alert" className="rounded-xl border p-4">This thesis was blocked and is private. No trade was placed.</p>}
    {thesis.publication?.status === 'failed' && <div role="alert" className="space-y-2 rounded-xl border p-4"><p>{publicationErrors[thesis.publication.errorCode ?? ''] ?? 'Publication did not complete. No trade was placed.'}</p><Link href="/write" className="text-primary underline">Write a new submission</Link></div>}
    <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-4 text-sm sm:grid-cols-3"><div><p className="text-muted-foreground">Position</p><p className={`font-semibold ${thesis.side === 'yes' ? 'text-yes' : 'text-no'}`}>{thesis.side.toUpperCase()}</p></div><div><p className="text-muted-foreground">Forecast YES</p><p className="font-semibold">{(Number(thesis.probabilityYes) * 100).toFixed(0)}%</p></div><div><p className="text-muted-foreground">Outcome</p><p className="font-semibold capitalize">{thesis.outcome ?? 'Pending'}</p></div></div>
    <section className="space-y-3"><h2 className="text-lg font-semibold">The thesis</h2><p className="whitespace-pre-wrap leading-relaxed">{thesis.body}</p></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Author’s evidence</h2>{thesis.evidence.map((item, i) => <a key={i} href={item.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border p-3 text-sm text-primary underline">{item.claim}<span className="mt-1 block text-xs text-muted-foreground">{new URL(item.url).hostname} ↗</span></a>)}</section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Automated audit</h2><p className="text-sm text-muted-foreground">{thesis.audit?.model === 'deterministic-btc-v1' ? 'Numeric template checks against the recorded Gemini inputs. Probability and edge are estimates.' : 'An automated evidence check, not a guarantee of accuracy. Predictions and opinions are not verified facts.'}</p>{!thesis.audit && <p className="text-sm text-muted-foreground">No audit has been recorded for this thesis.</p>}{thesis.audit?.claims.map((claim, i) => <article key={i} className="space-y-2 rounded-xl border p-4 text-sm"><p className="font-medium capitalize">{claim.status}</p><p>{claim.text}</p><p className="text-muted-foreground">{claim.note}</p>{claim.source_url && <a href={claim.source_url} target="_blank" rel="noopener noreferrer" className="text-primary underline">Inspect source ↗</a>}</article>)}{thesis.audit && <p className="text-xs text-muted-foreground">Check: {thesis.audit.model}. {thesis.audit.claims.length === 0 ? 'No checkable factual claims were identified.' : ''}</p>}</section>
    {thesis.position && <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Locked paper position</h2><p className="text-sm">{thesis.position.quantity} contracts at ${thesis.position.price}; cost ${thesis.position.costUsd}. {thesis.position.payoutUsd !== null ? `Settled payout $${thesis.position.payoutUsd}.` : 'Held until Gemini’s official resolution.'}</p><p className="text-xs text-muted-foreground">Simulated fill at a live quote. No USDC moved.</p></section>}
    <section className="space-y-2 text-xs text-muted-foreground"><p>Content hash: {thesis.contentHash ?? 'Unavailable'}</p>{thesis.registerTx ? <a href={`https://explorer.testnet.arc.io/tx/${thesis.registerTx}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">View Arc testnet registration ↗</a> : <p>No on-chain registration has been recorded for this thesis. Copying is unavailable.</p>}</section>
  </div>;
}
