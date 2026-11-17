import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACKED_RULES,
  EventSchema,
  resolveEventTickers,
  selectContracts,
  yesQuote,
  type TrackedRule,
} from '../src/index';
import { fixture } from './helpers';

const daily = EventSchema.parse(fixture('event-daily-categorical.json'));
const live15 = EventSchema.parse(fixture('event-15m-live.json'));
const pending15 = EventSchema.parse(fixture('event-15m-pending.json'));
const symbols = (contracts: Array<{ instrumentSymbol: string }>) =>
  contracts.map((c) => c.instrumentSymbol);

describe('yesQuote', () => {
  it('maps bestBid, bestAsk and lastTradePrice to the YES quote', () => {
    expect(yesQuote(live15.contracts[0]!)).toEqual({ bid: '0.22', ask: '0.29', last: null });
  });

  it('returns nulls when the book is empty', () => {
    expect(yesQuote(pending15.contracts[0]!)).toEqual({ bid: null, ask: null, last: null });
  });
});

describe('selectContracts', () => {
  it('"all" returns every contract', () => {
    expect(symbols(selectContracts(live15, { kind: 'all' }, []))).toEqual([
      'GEMI-ETH15M2611170745-UP',
    ]);
  });

  it('"tickers" returns the named contracts only', () => {
    const picked = selectContracts(daily, { kind: 'tickers', tickers: ['HI65000', 'NOPE'] }, []);
    expect(symbols(picked)).toEqual(['GEMI-BTC2611172200-HI65000']);
  });

  it('"nearestMoney" returns the contract whose YES mid is closest to 50 cents', () => {
    // HI64750: bid 0.46, ask 0.50, mid 0.48. HI64500: mid 0.555.
    const picked = selectContracts(daily, { kind: 'nearestMoney', count: 1 }, []);
    expect(symbols(picked)).toEqual(['GEMI-BTC2611172200-HI64750']);
    const two = selectContracts(daily, { kind: 'nearestMoney', count: 2 }, []);
    expect(symbols(two)).toEqual(['GEMI-BTC2611172200-HI64750', 'GEMI-BTC2611172200-HI64500']);
  });

  it('"nearestMoney" skips contracts that are closed or have no price', () => {
    expect(selectContracts(pending15, { kind: 'nearestMoney', count: 1 }, [])).toEqual([]);
    const closed = structuredClone(daily);
    for (const c of closed.contracts) {
      if (c.ticker === 'HI64750') c.marketState = 'closed';
    }
    const picked = selectContracts(closed, { kind: 'nearestMoney', count: 1 }, []);
    expect(symbols(picked)).toEqual(['GEMI-BTC2611172200-HI64500']);
  });

  it('"nearestMoney" keeps contracts that are already tracked instead of picking again', () => {
    const pinned = ['GEMI-BTC2611172200-HI66000'];
    const picked = selectContracts(daily, { kind: 'nearestMoney', count: 1 }, pinned);
    expect(symbols(picked)).toEqual(pinned);
  });

  it('"nearestMoney" picks again when none of the tracked contracts exist any more', () => {
    const picked = selectContracts(daily, { kind: 'nearestMoney', count: 1 }, ['GEMI-GONE']);
    expect(symbols(picked)).toEqual(['GEMI-BTC2611172200-HI64750']);
  });

  it('"nearestMoney" ranks a two-sided book ahead of a stale one-sided quote', () => {
    const event = structuredClone(daily);
    for (const c of event.contracts) {
      // No bid and an old ask of 0.51: looks closest to even, but nobody is quoting it.
      if (c.ticker === 'HI66000') c.prices = { bestAsk: '0.51' };
    }
    const picked = selectContracts(event, { kind: 'nearestMoney', count: 1 }, []);
    expect(symbols(picked)).toEqual(['GEMI-BTC2611172200-HI64750']);
  });

  it('"tickers" and "all" follow the rule, not what was tracked before', () => {
    const before = ['GEMI-BTC2611172200-HI66000'];
    const edited = selectContracts(daily, { kind: 'tickers', tickers: ['HI65000'] }, before);
    expect(symbols(edited)).toEqual(['GEMI-BTC2611172200-HI65000']);
    expect(selectContracts(daily, { kind: 'all' }, before)).toHaveLength(10);
  });
});

describe('resolveEventTickers', () => {
  const now = new Date('2026-11-17T07:27:13Z');

  it('returns a fixed ticker as is', () => {
    const rule: TrackedRule = {
      key: 'x',
      event: { kind: 'fixed', ticker: 'RECESSION26' },
      pick: { kind: 'all' },
      keywords: [],
    };
    expect(resolveEventTickers(rule, now)).toEqual(['RECESSION26']);
  });

  it('computes rolling tickers', () => {
    const rule: TrackedRule = {
      key: 'x',
      event: { kind: 'rolling', prefix: 'ETH15M', periodMinutes: 15, offsetMinutes: 0, count: 2 },
      pick: { kind: 'all' },
      keywords: [],
    };
    expect(resolveEventTickers(rule, now)).toEqual(['ETH15M2611170730', 'ETH15M2611170745']);
  });
});

describe('DEFAULT_TRACKED_RULES', () => {
  const now = new Date('2026-11-17T07:27:13Z');

  it('has unique keys and keyword groups for the extension', () => {
    const keys = DEFAULT_TRACKED_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of DEFAULT_TRACKED_RULES) {
      expect(rule.keywords.length, rule.key).toBeGreaterThan(0);
    }
  });

  it('tracks 8 to 12 contracts at a time, including BTC and ETH 15-minute events', () => {
    const slots = DEFAULT_TRACKED_RULES.flatMap((rule) =>
      resolveEventTickers(rule, now).flatMap((ticker) => {
        const perEvent =
          rule.pick.kind === 'nearestMoney'
            ? rule.pick.count
            : rule.pick.kind === 'tickers'
              ? rule.pick.tickers.length
              : 1;
        return Array.from({ length: perEvent }, () => ticker);
      }),
    );
    expect(slots.length).toBeGreaterThanOrEqual(8);
    expect(slots.length).toBeLessThanOrEqual(12);
    expect(slots).toContain('BTC15M2611170730');
    expect(slots).toContain('BTC15M2611170745');
    expect(slots).toContain('ETH15M2611170730');
    expect(slots).toContain('ETH15M2611170745');
  });
});
