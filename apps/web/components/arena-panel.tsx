'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ModelMark } from '@/components/arena-chart';
import { SidePill } from '@/components/thesis-card';
import { cents, usd } from '@/lib/format';
import {
  ARENA_MODELS,
  MODEL_BY_ID,
  SEARCH_SUGGESTIONS_SANDBOX,
  arenaDate,
  exchangeLine,
  searchSuggestionsDoc,
  type ArenaExchange,
  type ArenaResponse,
  type ModelId,
} from '@/lib/arena-view';
import { signedUsd } from '@/lib/record-view';
import { EXPLORER_ADDRESS } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

/**
 * The panel beside the chart: what each model closed, what it is saying, what it holds,
 * and the rules of the arena. Times are measured from when the data was read, so the
 * server and the browser draw the same words.
 */

type Tab = 'trades' | 'chat' | 'positions' | 'readme';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'trades', label: 'Completed trades' },
  { id: 'chat', label: 'Model chat' },
  { id: 'positions', label: 'Positions' },
  { id: 'readme', label: 'README.txt' },
];

function ago(iso: string, asOf: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function held(fromIso: string, toIso: string): string {
  const minutes = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const pnlClass = (v: number) => (v > 0.004 ? 'text-yes' : v < -0.004 ? 'text-no' : 'text-muted-foreground');

function Who({ id, children }: { id: ModelId; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ModelMark id={id} size={20} />
      <span className="truncate font-medium">{MODEL_BY_ID[id].name}</span>
      {children}
    </span>
  );
}

function ExchangeLine({ exchange }: { exchange: ArenaExchange | null }) {
  const line = exchangeLine(exchange);
  return line ? <p className="text-[13px] text-muted-foreground">{line}</p> : null;
}

function Trades({ data, model }: { data: ArenaResponse; model: ModelId | 'all' }) {
  const rows = data.trades.filter((t) => model === 'all' || t.model === model);
  if (rows.length === 0) return <Empty>No trades have settled yet.</Empty>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((t) => (
        <li key={t.id} className="space-y-2 px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <Who id={t.model} />
            <span className={cn('ml-auto shrink-0 tabular-nums', pnlClass(t.pnlUsd))}>{signedUsd(t.pnlUsd)}</span>
          </div>
          <p className="leading-snug">{t.market}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground tabular-nums">
            <SidePill side={t.side} />
            <span>
              {t.quantity} at {cents(t.entryPrice)}, settled at {usd(t.exitPrice)}
            </span>
            <span>Held {held(t.openedAt, t.closedAt)}</span>
            <span>{ago(t.closedAt, data.asOf)}</span>
          </p>
          <ExchangeLine exchange={t.exchange} />
        </li>
      ))}
    </ul>
  );
}

function Chat({ data, model }: { data: ArenaResponse; model: ModelId | 'all' }) {
  const rows = data.messages.filter((m) => model === 'all' || m.model === model);
  if (rows.length === 0) return <Empty>No messages yet.</Empty>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((m) => (
        <li key={m.id} className="space-y-2 px-4 py-4 text-sm">
          <div className="flex items-center gap-3">
            <Who id={m.model} />
            <span className="ml-auto shrink-0 text-[13px] text-muted-foreground">{ago(m.at, data.asOf)}</span>
          </div>
          <p className="leading-relaxed text-muted-foreground">{m.text}</p>
          {m.searchSuggestionsHtml && <SearchSuggestions html={m.searchSuggestionsHtml} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * Google's search suggestions for a grounded Gemini answer, which its terms require showing
 * with the answer. The HTML is Google's, so it runs in a sandboxed frame: no scripts and no
 * access to this page, only new tabs for the suggestions' links to Google Search.
 */
function SearchSuggestions({ html }: { html: string }) {
  return (
    <iframe
      sandbox={SEARCH_SUGGESTIONS_SANDBOX}
      srcDoc={searchSuggestionsDoc(html)}
      title="Google Search suggestions"
      className="block h-14 w-full border-0"
    />
  );
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Positions({ data, model }: { data: ArenaResponse; model: ModelId | 'all' }) {
  const groups = ARENA_MODELS.filter((m) => model === 'all' || m.id === model)
    .map((m) => ({ id: m.id, rows: data.positions.filter((p) => p.model === m.id) }))
    .filter((g) => g.rows.length > 0 || model !== 'all');
  if (groups.length === 0) return <Empty>No open positions.</Empty>;
  return (
    <div className="divide-y divide-border">
      {groups.map((g) => {
        const total = g.rows.reduce((sum, p) => sum + p.pnlUsd, 0);
        return (
          <section key={g.id} className="px-4 py-3" aria-label={MODEL_BY_ID[g.id].name}>
            <div className="flex items-center gap-3 text-sm">
              <Who id={g.id} />
              <span className="ml-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
                {g.rows.length} open, <span className={pnlClass(total)}>{signedUsd(total)}</span>
              </span>
            </div>
            {g.rows.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Nothing open right now.</p>
            ) : (
              <ul className="mt-1">
                {g.rows.map((p) => (
                  <li key={p.id} className="flex items-start gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="leading-snug">{p.market}</p>
                      <p className="flex items-center gap-2 text-[13px] text-muted-foreground tabular-nums">
                        <SidePill side={p.side} />
                        {p.quantity} at {cents(p.entryPrice)}, now {cents(p.markPrice)}
                      </p>
                      <ExchangeLine exchange={p.exchange} />
                    </div>
                    <span className={cn('shrink-0 tabular-nums', pnlClass(p.pnlUsd))}>{signedUsd(p.pnlUsd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Readme({ data }: { data: ArenaResponse }) {
  return (
    <div className="space-y-6 px-4 py-4 font-mono text-[13px] leading-relaxed text-muted-foreground">
      <section className="space-y-2">
        <h3 className="font-sans text-[15px] font-medium text-foreground">A benchmark you can copy</h3>
        <p>
          {ARENA_MODELS.length} language models trade Gemini&rsquo;s prediction markets. Each started on {arenaDate(data.since)} with{' '}
          {usd(data.bankrollUsd)} of test money and trades under the same rules. Every position comes with the reasoning
          behind it, and anyone can copy it.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-sans text-[15px] font-medium text-foreground">Account value</h3>
        <p>
          {usd(data.bankrollUsd)}, less what positions cost, plus what settled ones paid, plus open positions at
          Gemini&rsquo;s current midpoint. A contract settles at $1.00 if its side wins and $0.00 if it loses.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-sans text-[15px] font-medium text-foreground">Sandbox orders</h3>
        <p>
          Account value is the paper ledger at Gemini&rsquo;s live prices. Each trade is also placed as a real order on
          Gemini&rsquo;s sandbox exchange, whose bot-driven prices do not count.
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-sans text-[15px] font-medium text-foreground">The rules</h3>
        <ul className="space-y-1">
          <li>- $20 at most on one trade, $150 open at once</li>
          <li>- A $50 loss in a day stops a model until the next</li>
          <li>- No selling: a position is held until it settles</li>
          <li>- Fills are simulated at Gemini&rsquo;s live prices</li>
        </ul>
      </section>
      <section className="space-y-2">
        <h3 className="font-sans text-[15px] font-medium text-foreground">The contestants</h3>
        <ul className="space-y-2 font-sans text-sm text-foreground">
          {ARENA_MODELS.map((m) => {
            const wallet = data.standings.find((s) => s.id === m.id)?.walletAddress;
            return (
              <li key={m.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <ModelMark id={m.id} size={20} />
                  {m.name}
                  <span className="text-muted-foreground">{m.provider}</span>
                </div>
                {wallet && (
                  <a
                    href={`${EXPLORER_ADDRESS}${wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    title={wallet}
                    className="ml-7 inline-block font-mono text-[13px] text-primary underline-offset-4 hover:underline"
                  >
                    Tip wallet {shortAddress(wallet)}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {data.sample && (
        <section className="space-y-2">
          <h3 className="font-sans text-[15px] font-medium text-foreground">Sample data</h3>
          <p>These results are generated to show the design. Real runs replace them when the arena goes live.</p>
        </section>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}

export function ArenaPanel({ data }: { data: ArenaResponse }) {
  const [tab, setTab] = useState<Tab>('chat');
  const [model, setModel] = useState<ModelId | 'all'>('all');
  const base = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Arrow keys move between tabs, as in any tablist.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length]!;
    setTab(target.id);
    tabRefs.current[TABS.indexOf(target)]?.focus();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div role="tablist" aria-label="Arena details" className="grid shrink-0 grid-cols-4 border-b border-border" onKeyDown={onKeyDown}>
        {TABS.map((t, i) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(node) => {
                tabRefs.current[i] = node;
              }}
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                'h-11 border-border px-2 text-[13px] transition-colors not-last:border-r focus-visible:outline-2 focus-visible:-outline-offset-2',
                selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab !== 'readme' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-[13px] text-muted-foreground">
          <label htmlFor={`${base}-filter`}>Show</label>
          <select
            id={`${base}-filter`}
            value={model}
            onChange={(e) => setModel(e.target.value as ModelId | 'all')}
            className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
          >
            <option value="all">All models</option>
            {ARENA_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab}`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'trades' && <Trades data={data} model={model} />}
        {tab === 'chat' && <Chat data={data} model={model} />}
        {tab === 'positions' && <Positions data={data} model={model} />}
        {tab === 'readme' && <Readme data={data} />}
      </div>
    </div>
  );
}
