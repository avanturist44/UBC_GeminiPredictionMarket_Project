import { ARENA_ROSTER, type ModelId } from '@thesis/core';
import type { ArenaData, ArenaRun, Db, RaceMarket, RacePrice, RaceTrade } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArena } from '../lib/arena';
import { loadArena } from '../lib/arena-data';
import type { ArenaResponse } from '../lib/arena-view';

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
      'Traded on Oil (Brent) price on November 19, $90 or above. Brent holds above $90 into the close. Puts YES at 72%, 17 points from the price. Thesis sent to the auditor.',
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
