import type { RaceAgent, RaceData, RaceMarket, RacePrice, RaceTrade } from '@thesis/db';
import { describe, expect, it } from 'vitest';
import { buildRace, dealLabel } from '../lib/race';

const NOW = new Date('2026-11-18T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

const market = (id: string, overrides: Partial<RaceMarket> = {}): RaceMarket => ({
  id,
  instrumentSymbol: `GEMI-${id}`,
  title: `Oil (Brent) price on November 18 (${id})?`,
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
    createdAt: at(60),
    thesis: { id: `th${seq}`, headline: `Headline ${seq}`, body: `Body ${seq}`, probabilityYes: '0.7', publishedAt: at(60) },
    ...overrides,
  };
};

const agent = (agentKey: string, name: string, trades: RaceTrade[] = []): RaceAgent => ({
  agentKey,
  author: { id: `author-${agentKey}`, agentKey, displayName: name, strategySummary: `${name} strategy` },
  trades,
  latestRun: null,
});

function race(news: RaceTrade[], fade: RaceTrade[], markets: RaceMarket[], prices: RacePrice[] = []) {
  const all = [...news, ...fade].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const data: RaceData = {
    agents: [agent('news', 'News Desk', news), agent('fade', 'Fade', fade)],
    markets,
    prices,
    since: all[0]?.createdAt ?? null,
  };
  return buildRace('news-vs-fade', data, { now: NOW, bankrollUsd: 1000, slots: 4 });
}

describe('account value', () => {
  it('counts an open YES position at the midpoint', () => {
    const r = race([trade('m1')], [], [market('m1')]);
    // 10 YES bought for $5.00, now worth 10 × 0.65.
    expect(r.a).toMatchObject({ valueUsd: '1001.50', changeUsd: '1.50', tradeCount: 1 });
    expect(r.a.positions[0]).toMatchObject({ markPrice: '0.6500', valueUsd: '6.50', pnlUsd: '1.50', side: 'yes' });
  });

  it('counts a NO position at one minus the YES midpoint', () => {
    const r = race([trade('m1', { side: 'no' })], [], [market('m1')]);
    expect(r.a.positions[0]).toMatchObject({ markPrice: '0.3500', valueUsd: '3.50', pnlUsd: '-1.50' });
    expect(r.a.valueUsd).toBe('998.50');
  });

  it('counts a settled position at its payout, and no longer lists it as open', () => {
    const settled = trade('m1', { status: 'settled', payoutUsd: '10.0000' });
    const r = race([settled], [], [market('m1', { resolutionSide: 'yes', resolvedAt: at(10) })]);
    expect(r.a.valueUsd).toBe('1005.00');
    expect(r.a.positions).toEqual([]);
  });

  it('counts a resolved market at 1 or 0 before the resolver has paid it', () => {
    const r = race([trade('m1')], [], [market('m1', { resolutionSide: 'no', resolvedAt: at(5) })]);
    expect(r.a.valueUsd).toBe('995.00');
  });

  it('holds a position at its cost until the market has a quote', () => {
    const r = race([trade('m1')], [], [market('m1', { yesBid: null, yesAsk: null })]);
    expect(r.a.valueUsd).toBe('1000.00');
    expect(r.a.positions[0]!.markPrice).toBeNull();
  });
});

describe('the lead and the headline', () => {
  it('says the leader outperforms, on the market that made the difference', () => {
    const news = [trade('m1'), trade('m2', { createdAt: at(30) })];
    const fade = [trade('m2', { createdAt: at(20) })];
    // m1 rose for News only; on m2 both hold the same position.
    const r = race(news, fade, [market('m1', { yesBid: '0.80', yesAsk: '0.80' }), market('m2')]);
    expect(r.leader).toBe('a');
    expect(r.leadUsd).toBe('3.00');
    expect(r.headline).toBe('Watch News Desk outperform Fade');
    expect(r.deal).toMatchObject({ symbol: 'GEMI-m1', label: 'Oil (Brent) price on November 18 (m1), $90 or above' });
  });

  it('never says an agent that has not traded outperforms, even when it is ahead', () => {
    const r = race([trade('m1')], [], [market('m1', { yesBid: '0.20', yesAsk: '0.20' })]);
    expect(r.leader).toBe('b');
    expect(r.headline).toBe('Watch News Desk and Fade trade');
  });

  it('calls a level race a race, and names the latest market traded', () => {
    const r = race([trade('m1')], [trade('m2', { createdAt: at(10) })], [market('m1', { yesBid: '0.50', yesAsk: '0.50' }), market('m2', { yesBid: '0.50', yesAsk: '0.50' })]);
    expect(r.leader).toBeNull();
    expect(r.leadUsd).toBe('0.00');
    expect(r.headline).toBe('Watch News Desk and Fade trade');
    expect(r.deal?.symbol).toBe('GEMI-m2');
  });

  it('starts empty before either agent has traded', () => {
    const r = race([], [], []);
    expect(r).toMatchObject({ since: null, points: [], marks: [], deal: null, leader: null, headline: 'Watch News Desk and Fade race' });
    expect(r.a.valueUsd).toBe('1000.00');
  });
});

describe('the chart', () => {
  it('runs from the first trade to now, both lines starting at the bankroll and ending at today’s values', () => {
    const prices: RacePrice[] = [{ marketId: 'm1', ts: at(45), yesBid: '0.90', yesAsk: '0.90', lastPrice: null }];
    const r = race([trade('m1')], [], [market('m1')], prices);
    expect(r.points).toHaveLength(5);
    expect(r.points[0]).toEqual({ t: at(60).getTime(), a: 1000, b: 1000 });
    // 15 minutes in, the recorded 0.90 quote applies: 10 × 0.90 − 5.
    expect(r.points[1]).toEqual({ t: at(45).getTime(), a: 1004, b: 1000 });
    expect(r.points.at(-1)).toEqual({ t: NOW.getTime(), a: 1001.5, b: 1000 });
  });

  it('marks each position where it opened, on its own agent’s line', () => {
    const r = race([trade('m1', { side: 'no' })], [trade('m1', { createdAt: at(30) })], [market('m1')]);
    expect(r.marks.map((m) => [m.slot, m.side, m.value])).toEqual([
      ['a', 'no', 1000],
      ['b', 'yes', 1000],
    ]);
  });
});

describe('dealLabel', () => {
  it('drops the question mark and adds the contract', () => {
    expect(dealLabel({ title: 'Bitcoin price today at 10pm?', contractLabel: '$93,000 or above' })).toBe('Bitcoin price today at 10pm, $93,000 or above');
    expect(dealLabel({ title: 'Will it rain?', contractLabel: null })).toBe('Will it rain');
  });
});
