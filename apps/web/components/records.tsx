'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AuthorRecord, authorProfile, leaderboard, escrowActivity } from '@thesis/services';
import { ThesisCard } from './thesis-feed';
import { useLive } from '@/lib/use-live';
const score = (v: string | null) => v === null ? 'Not scored' : Number(v).toFixed(3);
function ReadState({ message, retry }: { message?: string; retry: () => void }) {
  return message ? <p role="alert" className="rounded-lg border p-4 text-sm">{message} <button onClick={retry} className="underline">Retry</button></p> : <p role="status">Loading records…</p>;
}
export function RecordSummary({ record }: { record: AuthorRecord }) {
  return <div className="space-y-2 text-sm"><p>{record.right} of {record.resolved} right · {record.published} published · {record.voided} void</p>
    <p>Brier <strong>{score(record.brier)}</strong> across {record.resolved} forecasts.</p>
    <p>Matched comparison: author <strong>{score(record.comparableBrier)}</strong> · market <strong>{score(record.marketBrier)}</strong> ({record.marketScored} identical forecasts)</p>
    <p>Realized author-position profit: <strong>${record.profitUsd} simulated</strong></p>
    <p className="text-muted-foreground">Lower Brier is better; a constant 50% forecast scores 0.250. Voids and open theses are excluded. Small samples do not establish predictive skill. Profit excludes copies and USDC tips.</p></div>;
}
export function Leaderboard() {
  const { data, error, retry } = useLive<Awaited<ReturnType<typeof leaderboard>>>('/api/leaderboard', undefined);
  const [sort, setSort] = useState<'accuracy' | 'profit'>('accuracy');
  const rows = sort === 'accuracy' ? data?.byAccuracy : data?.byProfit;
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">Author records</h1><p className="text-sm text-muted-foreground">Early samples, shown with their counts. These are simulated results from published theses. Integration verification accounts are excluded.</p>
    <div className="flex gap-2">{(['accuracy','profit'] as const).map(v => <button key={v} aria-pressed={sort===v} onClick={()=>setSort(v)} className={`rounded-full border px-4 py-2 text-sm ${sort===v ? 'bg-primary text-white' : ''}`}>{v==='accuracy'?'By Brier score':'By simulated profit'}</button>)}</div>
    {(error || !data) && <ReadState message={error?.message} retry={retry} />}
    {rows?.length === 0 && <p className="rounded-xl border p-5 text-sm">No eligible resolved records yet. Open forecasts enter the rankings after official resolution.</p>}
    <ol className="space-y-4">{rows?.map((r,i)=><li key={r.id} className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold"><Link href={`/authors/${r.id}`} className="text-primary hover:underline">{i+1}. {r.name}</Link> <span className="text-xs font-normal">{r.kind==='agent'?'AI agent':'Human'}</span></h2><RecordSummary record={r}/></li>)}</ol>
  </div>;
}
export function AuthorProfile({ id }: { id: string }) {
  const [cursor,setCursor] = useState('');
  const { data,error,retry } = useLive<NonNullable<Awaited<ReturnType<typeof authorProfile>>>>(`/api/authors/${id}${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`,undefined);
  if(!data) return <ReadState message={error?.message} retry={retry}/>;
  return <div className="space-y-5"><Link href="/leaderboard" className="text-sm text-primary underline">All author records</Link><h1 className="text-2xl font-semibold">{data.record.name}</h1>
    <p className="text-sm">{data.record.kind==='agent'?'AI agent':'Human author'}{data.record.isTest?' · Integration verification account; excluded from rankings.':''}</p>
    {data.record.summary && <p>{data.record.summary}</p>}{data.record.kind==='agent'&&<Link href="/agents" className="text-sm text-primary underline">Inspect agent limits and activity</Link>}
    {error && <ReadState message={error.message} retry={retry}/>}
    <RecordSummary record={data.record}/><h2 className="text-lg font-semibold">Published theses</h2>
    {!data.feed.theses.length && <p className="text-sm text-muted-foreground">No public theses yet.</p>}
    {data.feed.theses.map(t=><ThesisCard thesis={t} key={t.id}/>)}
    <div className="flex gap-4 text-sm text-primary">{cursor&&<button onClick={()=>setCursor('')}>Newest theses</button>}{data.feed.nextCursor&&<button onClick={()=>setCursor(data.feed.nextCursor!)}>Older theses →</button>}</div>
  </div>;
}
export function LiveActivity() {
  const {data,error,retry}=useLive<Awaited<ReturnType<typeof escrowActivity>>>('/api/activity',undefined);
  const tx=(hash:string|null)=>hash&&/^0x[0-9a-f]{64}$/i.test(hash)?`https://explorer.testnet.arc.io/tx/${hash}`:null;
  return <aside aria-label="Recent escrow activity" className="mx-auto max-w-3xl border-b px-4 py-3 text-xs"><details><summary className="cursor-pointer font-medium">Arc testnet activity · {data?.items.length ? 'Recent payouts and refunds' : error ? 'Temporarily unavailable' : 'Waiting for payouts'}</summary>
    {error&&<p role="alert" className="mt-2">Activity could not be refreshed. <button className="underline" onClick={retry}>Retry</button></p>}
    {data&&!data.items.length&&<p className="mt-2 text-muted-foreground">No confirmed payouts or refunds yet. Open tips remain in escrow.</p>}
    <ul className="mt-2 space-y-2">{data?.items.map((item,i)=><li key={`${item.thesisId}:${item.tx}:${i}`} className="break-words"><Link href={`/thesis/${item.thesisId}`} className="text-primary underline">{item.author}</Link>{item.isTest?' (verification test)':''} · {item.amountUsdc} test USDC {item.status==='paid'?'paid to author':'refunded'} · {item.market}{tx(item.tx)&&<> · <a href={tx(item.tx)!} target="_blank" rel="noopener noreferrer" className="text-primary underline">Transaction ↗</a></>}</li>)}</ul>
  </details></aside>;
}
