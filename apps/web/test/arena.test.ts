import { describe, expect, it } from 'vitest';
import { ARENA_START, buildArenaMock } from '../lib/arena-mock';
import { ARENA_MODELS, spreadLabels } from '../lib/arena-view';

const NOW = new Date('2026-11-19T04:20:00Z');

describe('the sample arena', () => {
  const arena = buildArenaMock(NOW);

  it('says it is sample data', () => {
    expect(arena.sample).toBe(true);
  });

  it('starts every model at the bankroll and ends each line at its card’s value', () => {
    const first = arena.points[0]!;
    const last = arena.points.at(-1)!;
    expect(first.t).toBe(ARENA_START);
    expect(last.t).toBe(NOW.getTime());
    for (const { id } of ARENA_MODELS) {
      expect(first[id]).toBe(1000);
      expect(last[id]).toBe(arena.standings.find((s) => s.id === id)!.valueUsd);
    }
  });

  it('never rewrites history: a later read agrees on every earlier point', () => {
    const later = buildArenaMock(new Date(NOW.getTime() + 5 * 60_000));
    const earlier = arena.points.slice(0, -1);
    expect(later.points.slice(0, earlier.length)).toEqual(earlier);
  });

  it('keeps moving between five-second reads', () => {
    const next = buildArenaMock(new Date(NOW.getTime() + 5000));
    expect(next.standings.map((s) => s.valueUsd)).not.toEqual(arena.standings.map((s) => s.valueUsd));
  });

  it('lists only trades that have settled and positions that are open, newest first', () => {
    expect(arena.trades.length).toBeGreaterThan(10);
    expect(arena.trades.every((t) => Date.parse(t.closedAt) <= NOW.getTime())).toBe(true);
    expect(arena.trades.every((t) => t.exitPrice === 0 || t.exitPrice === 1)).toBe(true);
    const closed = arena.trades.map((t) => Date.parse(t.closedAt));
    expect(closed).toEqual([...closed].sort((a, b) => b - a));
    for (const p of arena.positions) expect(Date.parse(p.openedAt)).toBeLessThanOrEqual(NOW.getTime());
    expect(arena.messages.every((m) => Date.parse(m.at) <= NOW.getTime())).toBe(true);
  });

  it('keeps every stake inside the agents’ $20 cap', () => {
    for (const t of [...arena.trades, ...arena.positions]) expect(t.quantity * t.entryPrice).toBeLessThanOrEqual(20.01);
  });

  it('only says the leader outperforms a model it is actually ahead of', () => {
    const m = arena.matchup!;
    const value = (id: string) => arena.standings.find((s) => s.id === id)!.valueUsd;
    expect(value(m.leader)).toBe(Math.max(...arena.standings.map((s) => s.valueUsd)));
    expect(value(m.trailer)).toBeLessThan(value(m.leader));
    expect(m.gapUsd).toBeCloseTo(value(m.leader) - value(m.trailer), 2);
    expect(m.headline).toMatch(/^Watch .+ outperform .+$/);
  });
});

describe('spreadLabels', () => {
  it('leaves labels that do not collide where they are', () => {
    expect(spreadLabels([10, 100, 50], 20, 0, 200)).toEqual([10, 100, 50]);
  });

  it('pushes colliding labels apart by the gap, in their original order', () => {
    const out = spreadLabels([100, 102, 104], 24, 0, 400);
    expect([...out].sort((a, b) => a - b).reduce((ok, y, i, all) => ok && (i === 0 || y - all[i - 1]! >= 24), true)).toBe(true);
    expect(out[0]).toBeLessThan(out[1]!);
    expect(out[1]).toBeLessThan(out[2]!);
  });

  it('stays inside the plot, pulling labels up from the bottom edge', () => {
    const out = spreadLabels([195, 198, 199], 20, 0, 200);
    expect(Math.max(...out)).toBeLessThanOrEqual(200);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
  });
});
