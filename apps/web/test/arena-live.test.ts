import { ARENA_ROSTER, type ModelId } from '@thesis/core';
import type { ArenaData, ArenaExchange, ArenaRun, Db, RaceMarket, RacePrice, RaceTrade } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArena } from '../lib/arena';
import { loadArena } from '../lib/arena-data';
import { buildArenaMock } from '../lib/arena-mock';
import { readFileSync } from 'node:fs';
import {
  SEARCH_SUGGESTIONS_SANDBOX,
  exchangeLine,
  searchSuggestionsDoc,
  showsSandboxOrders,
  type ArenaResponse,
} from '../lib/arena-view';

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('server-only', () => ({}));
vi.mock('../lib/db', () => ({ getDb: () => state.db }));

const NOW = new Date('2026-11-19T12:00:00Z');
const at = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00.000Z`).toISOString();
const KEY = Object.fromEntries(ARENA_ROSTER.map((e) => [e.id, e.agentKey])) as Record<ModelId, string>;
const NAME = Object.fromEntries(ARENA_ROSTER.map((e) => [e.id, e.displayName])) as Record<ModelId, string>;

const market = (id: string, overrides: Partial<RaceMarket> = {}): RaceMarket => ({
  id,
  instrumentSymbol: `GEMI-${id}`,
  title: `Oil (Brent) price on November 19 (${id})?`,
  contractLabel: '$90 or above',
  yesBid: '0.60',
  yesAsk: '0.70',
  lastPrice: null,
  resolutionSide: null,
  resolvedAt: null,
  status: 'active',
  ...overrides,
});

let seq = 0;
const trade = (marketId: string, overrides: Partial<RaceTrade> = {}): RaceTrade => {
  seq += 1;
  return {
    id: `t${seq}`,
    marketId,
    side: 'yes',
    quantity: '10',
    price: '0.50',
    costUsd: '5.0000',
    status: 'filled',
    payoutUsd: null,
    createdAt: new Date(at('09:00')),
    thesis: null,
    ...overrides,
  };
};

const run = (hhmm: string, overrides: Partial<ArenaRun> = {}): ArenaRun => ({
  decision: 'skip',
  reason: `Looked at ${hhmm}.`,
  createdAt: new Date(at(hhmm)),
  marketTitle: null,
  contractLabel: null,
  thesisHeadline: null,
  searchSuggestionsHtml: null,
  ...overrides,
});

function arenaData(
  options: {
    trades?: Partial<Record<ModelId, RaceTrade[]>>;
    runs?: Partial<Record<ModelId, ArenaRun[]>>;
    wallets?: Partial<Record<ModelId, string>>;
    markets?: RaceMarket[];
    prices?: RacePrice[];
    /** Mirror rows by trade id; a trade without one has no sandbox order. */
    exchanges?: Record<string, ArenaExchange>;
  } = {},
): ArenaData {
  const all = Object.values(options.trades ?? {})
    .flat()
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  return {
    agents: ARENA_ROSTER.map((e) => ({
      agentKey: e.agentKey,
      // An older author row can hold a stale name; the page never shows it.
      author: { id: `author-${e.id}`, agentKey: e.agentKey, displayName: `Old name ${e.id}`, strategySummary: null },
      trades: options.trades?.[e.id] ?? [],
      latestRun: null,
    })),
    markets: options.markets ?? [],
    prices: options.prices ?? [],
    since: all[0]?.createdAt ?? null,
    runs: new Map(ARENA_ROSTER.map((e) => [e.agentKey, options.runs?.[e.id] ?? []])),
    wallets: new Map(ARENA_ROSTER.map((e) => [e.agentKey, options.wallets?.[e.id] ?? null])),
    exchanges: new Map(Object.entries(options.exchanges ?? {})),
  };
}

const emptyData = () => arenaData();
const build = (data: ArenaData) => buildArena(data, { now: NOW, bankrollUsd: 1000 });
const standing = (a: ArenaResponse, id: ModelId) => a.standings.find((s) => s.id === id)!;

describe('the live arena', () => {
  it('live arena with no trades is empty, not sample', () => {
    const a = buildArena(emptyData(), { now: NOW, bankrollUsd: 1000 });
    expect(a.sample).toBe(false);
    expect(a.points).toEqual([]);
    expect(a.matchup).toBeNull();
    expect(a.standings.every((s) => s.valueUsd === 1000)).toBe(true);
    expect(a).toMatchObject({ trades: [], positions: [], messages: [], bankrollUsd: 1000, asOf: NOW.toISOString() });
    expect(a.standings.map((s) => s.id)).toEqual(ARENA_ROSTER.map((e) => e.id));
    expect(a.standings.every((s) => s.changeUsd === 0 && s.changePct === 0)).toBe(true);
  });

  it('counts each model on its own ledger', () => {
    // gpt: 10 YES at 0.50, mid now 0.65; claude: settled, paid $10 on $5.
    const a = build(
      arenaData({
        trades: {
          gpt: [trade('m1')],
          claude: [trade('m2', { status: 'settled', payoutUsd: '10.0000' })],
        },
        markets: [market('m1'), market('m2', { resolutionSide: 'yes', resolvedAt: new Date(at('11:00')) })],
      }),
    );
    expect(standing(a, 'gpt').valueUsd).toBe(1001.5);
    expect(standing(a, 'claude').valueUsd).toBe(1005);
    expect(standing(a, 'grok').valueUsd).toBe(1000);
    expect(standing(a, 'gpt').changeUsd).toBe(1.5);
    expect(standing(a, 'gpt').changePct).toBeCloseTo(0.15, 10);
  });

  it('never says an idle model outperforms', () => {
    // Only gpt traded, and lost.
    const a = build(
      arenaData({
        trades: { gpt: [trade('m1')] },
        markets: [market('m1', { resolutionSide: 'no', resolvedAt: new Date(at('11:00')) })],
      }),
    );
    expect(standing(a, 'gpt').valueUsd).toBe(995);
    expect(a.matchup?.headline ?? '').not.toMatch(/^Watch Claude/);
    expect(a.matchup).toBeNull();
  });

  it('names a leader that traded and is ahead, on the market where it gained most, by roster name', () => {
    const a = build(
      arenaData({
        trades: {
          gpt: [trade('m1')],
          claude: [trade('m2', { status: 'settled', payoutUsd: '10.0000' })],
        },
        markets: [market('m1'), market('m2', { resolutionSide: 'yes', resolvedAt: new Date(at('11:00')) })],
      }),
    );
    expect(a.matchup).toEqual({
      leader: 'claude',
      trailer: 'gpt',
      deal: 'Oil (Brent) price on November 19 (m2), $90 or above',
      gapUsd: 3.5,
      headline: `Watch ${NAME.claude} outperform ${NAME.gpt}`,
    });
    expect(JSON.stringify(a)).not.toContain('Old name');
  });

  it('lists settled positions as completed trades: 1 if the side won, 0 if it lost, the stake back if void', () => {
    const a = build(
      arenaData({
        trades: {
          claude: [
            trade('won', { status: 'settled', payoutUsd: '10.0000' }),
            trade('lost', { status: 'settled', payoutUsd: '0.0000', createdAt: new Date(at('09:30')) }),
            trade('void', { status: 'settled', payoutUsd: '5.0000', createdAt: new Date(at('10:00')) }),
          ],
        },
        markets: [
          market('won', { resolutionSide: 'yes', resolvedAt: new Date(at('11:00')) }),
          market('lost', { resolutionSide: 'no', resolvedAt: new Date(at('11:30')) }),
          market('void', { resolutionSide: null, resolvedAt: new Date(at('10:30')) }),
        ],
      }),
    );
    expect(a.trades.map((t) => [t.market, t.exitPrice, t.pnlUsd, t.closedAt])).toEqual([
      ['Oil (Brent) price on November 19 (lost), $90 or above', 0, -5, at('11:30')],
      ['Oil (Brent) price on November 19 (won), $90 or above', 1, 5, at('11:00')],
      ['Oil (Brent) price on November 19 (void), $90 or above', 0.5, 0, at('10:30')],
    ]);
    expect(a.trades[0]).toMatchObject({ model: 'claude', side: 'yes', quantity: 10, entryPrice: 0.5, openedAt: at('09:30') });
    expect(a.positions).toEqual([]);
    expect(standing(a, 'claude').valueUsd).toBe(1000);
  });

  it('lists open positions at the current midpoint, newest first, and leaves them out of completed trades', () => {
    const a = build(
      arenaData({
        trades: {
          gpt: [trade('m1', { side: 'no', id: 'older' }), trade('m2', { id: 'newer', createdAt: new Date(at('10:00')) })],
        },
        markets: [market('m1'), market('m2', { yesBid: null, yesAsk: null })],
      }),
    );
    expect(a.trades).toEqual([]);
    expect(a.positions.map((p) => [p.id, p.side, p.markPrice, p.pnlUsd])).toEqual([
      // No quote yet: held at what it cost.
      ['newer', 'yes', 0.5, 0],
      ['older', 'no', 0.35, -1.5],
    ]);
    expect(a.positions[1]).toMatchObject({ model: 'gpt', quantity: 10, entryPrice: 0.5, openedAt: at('09:00') });
  });

  it('carries each trade\'s sandbox order status', () => {
    const a = build(
      arenaData({
        trades: {
          claude: [
            trade('s1', { id: 'done', status: 'settled', payoutUsd: '10.0000' }),
            trade('s2', { id: 'cold', status: 'settled', payoutUsd: '0.0000', createdAt: new Date(at('09:30')) }),
            trade('s3', { id: 'none', status: 'settled', payoutUsd: '0.0000', createdAt: new Date(at('10:00')) }),
          ],
          gpt: [trade('m1', { id: 'open-part' }), trade('m2', { id: 'open-none', createdAt: new Date(at('10:00')) })],
        },
        markets: [
          market('s1', { resolutionSide: 'yes', resolvedAt: new Date(at('11:00')) }),
          market('s2', { resolutionSide: 'no', resolvedAt: new Date(at('11:30')) }),
          market('s3', { resolutionSide: 'no', resolvedAt: new Date(at('10:30')) }),
          market('m1'),
          market('m2'),
        ],
        exchanges: {
          done: { status: 'filled', filledQuantity: '10.0000', sandboxPrice: '0.5500' },
          cold: { status: 'unfilled', filledQuantity: null, sandboxPrice: null },
          'open-part': { status: 'partial', filledQuantity: '4.5000', sandboxPrice: '0.5000' },
        },
      }),
    );
    const byId = (id: string) => a.trades.find((t) => t.id === id)!;
    expect(byId('done').exchange).toEqual({ status: 'filled', quantity: 10, price: 0.55 });
    expect(byId('cold').exchange).toEqual({ status: 'unfilled', quantity: null, price: null });
    expect(byId('none').exchange).toBeNull();
    expect(a.positions.find((p) => p.id === 'open-part')!.exchange).toEqual({ status: 'partial', quantity: 4.5, price: 0.5 });
    expect(a.positions.find((p) => p.id === 'open-none')!.exchange).toBeNull();
    // Only status, quantity and price reach the page.
    expect(Object.keys(byId('done').exchange!).sort()).toEqual(['price', 'quantity', 'status']);
    // So the README speaks of sandbox orders.
    expect(showsSandboxOrders(a)).toBe(true);
  });

  it('says nothing of sandbox orders when no trade or position on the page has one', () => {
    const none = build(arenaData({ trades: { gpt: [trade('m1')] }, markets: [market('m1')] }));
    expect(showsSandboxOrders(none)).toBe(false);
    const onlyOpen = build(
      arenaData({
        trades: { gpt: [trade('m1', { id: 'open' })] },
        markets: [market('m1')],
        exchanges: { open: { status: 'pending', filledQuantity: null, sandboxPrice: null } },
      }),
    );
    expect(showsSandboxOrders(onlyOpen)).toBe(true);
    // The README's paragraph is drawn only then.
    const panel = readFileSync(new URL('../components/arena-panel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/\{showsSandboxOrders\(data\) && \(\s*<section[^>]*>\s*<h3[^>]*>Sandbox orders<\/h3>/);
  });

  it('draws every line from the first trade at the bankroll to today’s values', () => {
    const a = build(arenaData({ trades: { gpt: [trade('m1')] }, markets: [market('m1')] }));
    const first = a.points[0]!;
    const last = a.points.at(-1)!;
    expect(a.since).toBe(at('09:00'));
    expect(first.t).toBe(Date.parse(at('09:00')));
    expect(last.t).toBe(NOW.getTime());
    for (const { id } of ARENA_ROSTER) {
      expect(first[id]).toBe(1000);
      expect(last[id]).toBe(standing(a, id).valueUsd);
    }
  });

  it('turns agent runs into model chat, newest first', () => {
    // Runs at 10:00 and 11:00.
    const a = build(arenaData({ runs: { gpt: [run('11:00')], claude: [run('10:00')] } }));
    expect(a.messages.map((m) => m.at)).toEqual([at('11:00'), at('10:00')]);
    expect(a.messages.map((m) => m.model)).toEqual(['gpt', 'claude']);
  });

  it('says what each run looked at and, when it traded, the thesis headline', () => {
    const a = build(
      arenaData({
        runs: {
          gemini: [
            run('11:00', {
              decision: 'trade',
              reason: 'Puts YES at 72%, 17 points from the price. Thesis sent to the auditor.',
              marketTitle: 'Oil (Brent) price on November 19?',
              contractLabel: '$90 or above',
              thesisHeadline: 'Brent holds above $90 into the close',
              searchSuggestionsHtml: '<div class="chip">brent close</div>',
            }),
            run('10:00', { reason: 'An earlier thesis is still with the auditor.' }),
            run('09:00', { reason: null }),
          ],
        },
      }),
    );
    expect(a.messages.map((m) => m.text)).toEqual([
      // A look that traded only sent its thesis to the auditor: the fill comes after the audit.
      'Sent a thesis on Oil (Brent) price on November 19, $90 or above. Brent holds above $90 into the close. Puts YES at 72%, 17 points from the price. Thesis sent to the auditor.',
      'Passed. An earlier thesis is still with the auditor.',
    ]);
    expect(a.messages[0]!.searchSuggestionsHtml).toBe('<div class="chip">brent close</div>');
    expect(a.messages[1]).not.toHaveProperty('searchSuggestionsHtml');
    expect(new Set(a.messages.map((m) => m.id)).size).toBe(2);
  });

  it('gives a model’s wallet only when its author has one', () => {
    const a = build(arenaData({ wallets: { claude: '0xabc0000000000000000000000000000000000001' } }));
    expect(standing(a, 'claude').walletAddress).toBe('0xabc0000000000000000000000000000000000001');
    expect(standing(a, 'gpt')).not.toHaveProperty('walletAddress');
  });
});

describe('the sandbox order line', () => {
  it('says what the exchange did, in whole cents and plain numbers, and nothing without an order', () => {
    expect(exchangeLine({ status: 'filled', quantity: 10, price: 0.55 })).toBe('Sandbox order filled, 10 at 55¢');
    expect(exchangeLine({ status: 'partial', quantity: 4.5, price: 0.5 })).toBe('Sandbox order partly filled, 4.5 at 50¢');
    expect(exchangeLine({ status: 'unfilled', quantity: null, price: null })).toBe('Sandbox order not filled');
    expect(exchangeLine({ status: 'pending', quantity: null, price: null })).toBe('Sandbox order pending');
    expect(exchangeLine({ status: 'failed', quantity: null, price: null })).toBe('Sandbox order failed');
    expect(exchangeLine(null)).toBeNull();
  });

  it('is absent from the sample, and the README names no particular sandbox account', () => {
    const sample = buildArenaMock(NOW);
    expect([...sample.trades, ...sample.positions].every((row) => row.exchange === null)).toBe(true);
    expect(showsSandboxOrders(sample)).toBe(false);
    const panel = readFileSync(new URL('../components/arena-panel.tsx', import.meta.url), 'utf8');
    expect(panel).not.toMatch(/own sandbox account|model.s own/i);
  });
});

describe('Gemini’s search suggestions', () => {
  it('run with popups only: no scripts and no access to this page', () => {
    expect(SEARCH_SUGGESTIONS_SANDBOX).toBe('allow-popups allow-popups-to-escape-sandbox');
    // The panel's one frame takes exactly that value.
    const panel = readFileSync(new URL('../components/arena-panel.tsx', import.meta.url), 'utf8');
    expect(panel.match(/sandbox=\{?[^\s>]+/g)).toEqual(['sandbox={SEARCH_SUGGESTIONS_SANDBOX}']);
    expect(panel).toContain('srcDoc={searchSuggestionsDoc(html)}');
  });

  it('open every suggestion in a new tab, with Google’s HTML unchanged after the head', () => {
    const html = '<style>.chip{}</style><div class="carousel"><a class="chip" href="https://www.google.com/search?q=brent">brent</a></div>';
    const doc = searchSuggestionsDoc(html);
    expect(doc.startsWith('<!doctype html><base target="_blank">')).toBe(true);
    expect(doc.endsWith(html)).toBe(true);
  });
});

describe('loadArena', () => {
  const before = process.env.ARENA_SOURCE;
  afterEach(() => {
    if (before === undefined) delete process.env.ARENA_SOURCE;
    else process.env.ARENA_SOURCE = before;
    state.db = null;
  });

  it('serves the sample unless ARENA_SOURCE is live', async () => {
    delete process.env.ARENA_SOURCE;
    const unset = await loadArena(NOW);
    expect(unset.ok && unset.data.sample).toBe(true);
    process.env.ARENA_SOURCE = 'sample';
    const sample = await loadArena(NOW);
    expect(sample.ok && sample.data.sample).toBe(true);
  });

  it('never falls back to sample numbers when live has no database', async () => {
    process.env.ARENA_SOURCE = 'live';
    expect(await loadArena(NOW)).toMatchObject({ ok: false, status: 503, error: { code: 'not_configured' } });
  });

  it('reads real trades when ARENA_SOURCE is live', async () => {
    process.env.ARENA_SOURCE = 'live';
    const { db, close } = await createTestDb();
    state.db = db;
    try {
      const loaded = await loadArena(NOW);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data).toMatchObject({ sample: false, points: [], trades: [], positions: [], messages: [], matchup: null });
      expect(loaded.data.standings.map((s) => s.valueUsd)).toEqual(ARENA_ROSTER.map(() => 1000));
    } finally {
      await close();
    }
  });
});
