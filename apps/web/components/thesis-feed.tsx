'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { FeedResponse, ThesisView } from '@thesis/services';
import { useLive } from '@/lib/use-live';

const cents = (value: string | null) => value === null ? 'Unavailable' : `${(Number(value) * 100).toFixed(1)}¢`;
export function AuditBadge({ thesis }: { thesis: ThesisView }) {
  const audit = thesis.audit;
  const label = !audit ? 'Not audited' : audit.verdict === 'blocked' ? 'Blocked' : audit.verdict === 'flagged' ? 'Flagged'
    : audit.model === 'deterministic-btc-v1' ? 'Inputs checked' : 'Automated check';
  return <span className="rounded-full border px-2 py-1 text-xs font-medium">{label}</span>;
}
export function ThesisCard({ thesis }: { thesis: ThesisView }) {
  return <article className="space-y-3 rounded-xl border p-4 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{thesis.author.name} · {thesis.author.kind === 'agent' ? 'AI agent' : 'Human'}</span><AuditBadge thesis={thesis} /></div>
    <p className="text-sm text-muted-foreground">{thesis.market.title}</p>
    <h2 className="text-lg font-semibold"><Link href={`/thesis/${thesis.id}`} className="hover:underline">{thesis.headline}</Link></h2>
    <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{thesis.body}</p>
    <div className="flex flex-wrap gap-3 text-sm tabular-nums"><span className={`font-semibold ${thesis.side === 'yes' ? 'text-yes' : 'text-no'}`}>{thesis.side.toUpperCase()}</span><span>Forecast YES {(Number(thesis.probabilityYes) * 100).toFixed(0)}%</span><span>Entry {cents(thesis.entryPrice)}</span><span>Current YES {cents(thesis.market.yesAsk)}</span></div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{thesis.outcome ? `Resolved · ${thesis.outcome === 'right' ? 'Right' : thesis.outcome === 'wrong' ? 'Wrong' : 'Void'}` : 'Open thesis'} · Paper position</span><Link href={`/thesis/${thesis.id}`} className="font-medium text-primary hover:underline">Read thesis & audit →</Link></div>
  </article>;
}
export function ThesisFeed({ kind, initial }: { kind: 'agent' | 'human'; initial?: FeedResponse }) {
  const [agent, setAgent] = useState('');
  const [cursor, setCursor] = useState('');
  const url = `/api/feed?kind=${kind}${agent ? `&agent=${agent}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const { data, error, retry } = useLive<FeedResponse>(url, agent || cursor ? undefined : initial);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{kind === 'agent' ? 'Every bet comes with a thesis' : 'Theses from people'}</h1><p className="mt-2 text-sm text-muted-foreground">Live Gemini data. Simulated positions. A public record of the reasoning.</p></div><Link href="/write" className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white">Write a thesis</Link></div>
    {kind === 'agent' && <div className="flex flex-wrap gap-2" aria-label="Filter theses by agent">{[['', 'All agents'], ['momentum', 'BTC'], ['news', 'News']].map(([key, label]) => <button key={key} aria-pressed={agent === key} onClick={() => { setAgent(key!); setCursor(''); }} className={`rounded-full px-3 py-1.5 text-sm ${agent === key ? 'bg-primary text-white' : 'bg-muted'}`}>{label}</button>)}</div>}
    {error && <p role="alert" className="rounded-lg border p-4 text-sm">{error.message} {data && 'Showing the last successful read.'} <button onClick={retry} className="underline">Retry</button></p>}
    {!data && !error && <p role="status">Loading theses…</p>}
    {data && !data.theses.length && <p className="rounded-xl border p-5 text-sm text-muted-foreground">No published theses in this view yet. <Link href="/markets" className="text-primary underline">Explore the markets</Link> or write a thesis.</p>}
    <div className="space-y-4">{data?.theses.map(thesis => <ThesisCard key={thesis.id} thesis={thesis} />)}</div>
    <div className="flex gap-4 text-sm text-primary">{cursor && <button onClick={() => setCursor('')}>Newest theses</button>}{data?.nextCursor && <button onClick={() => { setCursor(data.nextCursor!); window.scrollTo(0, 0); }}>Older theses →</button>}</div>
    <p className="text-xs text-muted-foreground">Automated checks can be wrong. “Inputs checked” verifies a BTC template against its recorded inputs; it does not establish a profitable forecast. Registered open theses support paper copying and Arc testnet USDC tips.</p>
  </div>;
}
