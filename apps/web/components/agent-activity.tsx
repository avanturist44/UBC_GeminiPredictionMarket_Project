'use client';
import { useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Clock3 } from 'lucide-react';
import { useLive, useNow } from '@/lib/use-live';
import type { Activity, ActivityResponse } from '@/lib/agent-activity';

const names: Record<string, string> = { momentum: 'BTC momentum', news: 'News research' };
function age(at: string, now: Date) {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
function Stage({ event, now }: { event: Activity; now: Date }) {
  const stale = now.getTime() - new Date(event.at).getTime() > 120_000;
  return <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
    {stale && event.stage === 'Researching' ? 'Research update overdue' : event.stage}
  </span>;
}
export function AgentActivity({ initial }: { initial?: ActivityResponse }) {
  const { data, error, retry } = useLive<ActivityResponse>('/api/agents/activity', initial);
  const { now } = useNow(initial?.asOf);
  const [filter, setFilter] = useState('all');
  const events = data?.events ?? [];
  return <div className="space-y-7">
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium text-primary"><ActivityIcon size={16} /> INSIDE THE AGENTS</p>
      <h1 className="text-3xl font-semibold tracking-tight">Watch the decisions unfold.</h1>
      <p className="max-w-xl text-muted-foreground">Follow the inputs, checks and evidence behind each decision. These are recorded decision summaries, not private model reasoning.</p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 size={13} /> Refreshes every 5 seconds{data ? ` · Read ${age(data.asOf, now)}` : ''}</p>
    </div>
    {error && <div role="alert" className="rounded-xl border p-4 text-sm">{error.message} {data && 'Showing the last successful read.'} <button className="underline" onClick={retry}>Retry</button></div>}
    {!data && !error && <p role="status">Loading recorded activity…</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {Object.entries(names).map(([key, name]) => {
        const latest = events.find(event => event.agent === key);
        const stale = latest && now.getTime() - new Date(latest.at).getTime() > 120_000;
        return <section key={key} className="space-y-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{name}</h2><span className="text-xs text-muted-foreground">{key === 'momentum' ? 'Paper trading' : 'Log only'}</span></div>
          {latest ? <><Stage event={latest} now={now} /><p className="pt-1 text-sm text-muted-foreground">{latest.summary}</p><p className="text-xs text-muted-foreground">Last decision {age(latest.at, now)}{stale ? ' · No recent update' : ''}</p></> : <p className="text-sm text-muted-foreground">No recorded runs. Activity appears when this agent runs; this page does not start it.</p>}
        </section>;
      })}
    </div>
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Decision journal</h2>
        <div className="flex gap-1" aria-label="Filter agent activity">{([['all', 'All'], ['momentum', 'BTC'], ['news', 'News']] as const).map(([key, label]) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`rounded-full px-3 py-1 text-sm ${filter === key ? 'bg-primary text-white' : 'bg-muted'}`}>{label}</button>)}</div>
      </div>
      {data && !events.filter(event => filter === 'all' || event.agent === filter).length && <p className="rounded-xl border p-5 text-sm text-muted-foreground">No decisions recorded yet for this view.</p>}
      <div className="space-y-3">{events.filter(event => filter === 'all' || event.agent === filter).map(event => <article key={event.id} className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{names[event.agent]} <span className="font-normal text-muted-foreground">· {event.mode}</span></span><time dateTime={event.at} title={event.at} className="text-xs text-muted-foreground">{age(event.at, now)}</time></div>
        <Stage event={event} now={now} />
        {event.market && <h3 className="pt-1 font-medium">{event.market}</h3>}
        <p className="text-sm leading-relaxed text-muted-foreground">{event.summary}</p>
        {event.checks.length > 0 && <details><summary className="cursor-pointer text-sm font-medium text-primary">Inputs & checks ({event.checks.length})</summary><dl className="mt-3 grid grid-cols-2 gap-3 rounded-lg bg-muted p-3 sm:grid-cols-3">{event.checks.map(check => <div key={check.label}><dt className="text-xs text-muted-foreground">{check.label}</dt><dd className="text-sm font-medium tabular-nums">{check.value}</dd></div>)}</dl></details>}
        {event.sources.length > 0 && <div className="space-y-2 border-t pt-3"><p className="text-xs text-muted-foreground">Research sources · Not independently audited</p>{event.sources.map((source, i) => <a key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1 text-sm text-primary underline underline-offset-2">{source.claim || new URL(source.url).hostname}<ArrowUpRight size={14} className="mt-1 shrink-0" /></a>)}</div>}
      </article>)}</div>
      <p className="text-xs text-muted-foreground">Latest 20 records per agent, plus six recent BTC fills and settlements. A hypothetical signal is not a fill. Paper entries use simulated funds. Source citations are evidence to inspect, not a guarantee of accuracy.</p>
    </section>
  </div>;
}

