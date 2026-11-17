import { describe, expect, it } from 'vitest';
import {
  EventListSchema,
  EventSchema,
  StrikeSchema,
  findUnknownKeys,
  type GeminiEvent,
} from '../src/index';
import { fixture } from './helpers';

// "Real event JSON saved in Phase 0 parses under the zod schemas."
describe('Gemini schemas against recorded responses', () => {
  it('parses a live 15-minute event with two-sided prices and a strike', () => {
    const event = EventSchema.parse(fixture('event-15m-live.json'));
    expect(event.ticker).toBe('ETH15M2611170745');
    expect(event.sourceDetails).toMatchObject({ agency: 'lukka' });
    const [up] = event.contracts;
    expect(up?.instrumentSymbol).toBe('GEMI-ETH15M2611170745-UP');
    expect(up?.prices?.bestBid).toBe('0.22');
    expect(up?.prices?.bestAsk).toBe('0.29');
    expect(up?.strike?.value).toBe('1830.11');
    expect(up?.quantityIncrement).toBe('0.01');
    // The single-event response omits resolutionSide until the contract resolves.
    expect(up?.resolutionSide ?? null).toBeNull();
  });

  it('parses an event before its window: no prices, strike has no value yet', () => {
    const event = EventSchema.parse(fixture('event-15m-pending.json'));
    const [up] = event.contracts;
    expect(up?.prices?.bestBid).toBeUndefined();
    expect(up?.prices?.bestAsk).toBeUndefined();
    expect(up?.strike?.value).toBeUndefined();
    expect(up?.strike?.availableAt).toBe('2026-11-17T07:30:00.000Z');
  });

  it('parses a settled event with its resolution', () => {
    const event = EventSchema.parse(fixture('event-15m-settled.json'));
    expect(event.status).toBe('settled');
    expect(event.contracts[0]?.resolutionSide).toBe('yes');
    expect(event.contracts[0]?.resolvedAt).toBe('2026-11-17T07:00:07.595Z');
    // The index value the contract settled against, compared with its strike.
    expect(event.contracts[0]?.settlementValue).toBe('64482.425833333335');
    expect(event.contracts[0]?.strike?.value).toBe('64388.56');
  });

  it('parses categorical and long-dated binary events', () => {
    const daily = EventSchema.parse(fixture('event-daily-categorical.json'));
    expect(daily.type).toBe('categorical');
    expect(daily.contracts).toHaveLength(10);
    expect(daily.contracts[0]?.strike).toMatchObject({ type: 'above', value: '63750' });

    const long = EventSchema.parse(fixture('event-binary-long.json'));
    expect(long.contracts[0]?.instrumentSymbol).toBe('GEMI-RECESSION26-2026');
    // One-sided book: only an ask.
    expect(long.contracts[0]?.prices?.bestBid ?? null).toBeNull();
    expect(long.contracts[0]?.prices?.bestAsk).toBe('0.04');
  });

  it('parses list responses, including sports and weather events', () => {
    const list = EventListSchema.parse(fixture('events-list-sample.json'));
    expect(list.data.map((e) => e.ticker)).toEqual([
      'NCAAM-2611180000-MSST-UCF-M',
      'BRENT2611172200',
      'WXHIGH-NYC-2611180459',
      'XRP05M2611170735',
    ]);
    expect(list.pagination).toEqual({ limit: 500, offset: 0, total: 1000 });

    const settled = EventListSchema.parse(fixture('recently-settled-sample.json'));
    expect(settled.data).toHaveLength(4);
    for (const event of settled.data) {
      for (const contract of event.contracts) {
        expect(['yes', 'no']).toContain(contract.resolutionSide);
      }
    }
  });

  it('parses strike responses during and before the window', () => {
    expect(StrikeSchema.parse(fixture('strike-ready.json')).value).toBe('1830.11');
    expect(StrikeSchema.parse(fixture('strike-pending.json')).value).toBeUndefined();
  });

  it('rejects a resolution side it does not know, since money depends on it', () => {
    const raw = fixture('event-15m-settled.json') as { contracts: Array<Record<string, unknown>> };
    raw.contracts[0]!.resolutionSide = 'maybe';
    expect(EventSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a price that is not a decimal', () => {
    const raw = fixture('event-15m-live.json') as {
      contracts: Array<{ prices: Record<string, unknown> }>;
    };
    raw.contracts[0]!.prices.bestAsk = 'abc';
    expect(EventSchema.safeParse(raw).success).toBe(false);
  });
});

describe('findUnknownKeys', () => {
  const names = [
    'event-15m-live.json',
    'event-15m-pending.json',
    'event-15m-settled.json',
    'event-daily-categorical.json',
    'event-binary-long.json',
  ];

  it('reports nothing for the responses recorded in Phase 0', () => {
    for (const name of names) {
      expect(findUnknownKeys(fixture(name) as GeminiEvent), name).toEqual([]);
    }
    const list = fixture('events-list-sample.json') as { data: GeminiEvent[] };
    for (const event of list.data) {
      expect(findUnknownKeys(event), event.ticker).toEqual([]);
    }
    const settled = fixture('recently-settled-sample.json') as { data: GeminiEvent[] };
    for (const event of settled.data) {
      expect(findUnknownKeys(event), event.ticker).toEqual([]);
    }
  });

  it('names new fields on the event and on a contract, and parsing still succeeds', () => {
    const raw = fixture('event-15m-live.json') as Record<string, unknown> & {
      contracts: Array<Record<string, unknown>>;
    };
    raw.brandNewField = 1;
    raw.contracts[0]!.anotherNewField = 'x';
    const event = EventSchema.parse(raw);
    expect(findUnknownKeys(event).sort()).toEqual(['contract.anotherNewField', 'event.brandNewField']);
  });
});
