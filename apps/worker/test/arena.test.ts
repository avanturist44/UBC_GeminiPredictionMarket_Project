import {
  ARENA_ROSTER,
  LlmError,
  createLlm,
  type GenerateJsonArgs,
  type Llm,
  type LlmCompletion,
  type LlmRequest,
  type ModelId,
  type NewsEstimate,
} from '@thesis/core';
import {
  agentRuns,
  agentState,
  authors,
  eq,
  theses,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runArenaCycle, type ArenaContender } from '../src/arena';
import { createThesisPipeline } from '../src/thesis-pipeline';

const NOW = new Date('2026-11-18T05:00:00Z');

/** A 0.6 market: YES bid 58¢, ask 62¢. */
const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BRENT2611182200-HI90',
  eventTicker: 'BRENT2611182200',
  contractTicker: 'HI90',
  title: 'Oil (Brent) price on November 18?',
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-18T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '90',
  yesBid: '0.58',
  yesAsk: '0.62',
  lastPrice: '0.60',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

/** A full estimate; 0.6 has no edge on the 0.6 market. */
const estimate = (overrides: Partial<NewsEstimate> = {}): NewsEstimate => ({
  probability_yes: 0.6,
  confidence: 'medium',
  headline: 'Three weeks of draws point to a close above $90',
  body: 'US crude stocks fell for a third week and the prompt spread tightened.',
  evidence: [
    { claim: 'EIA weekly report shows a draw', url: 'https://www.eia.gov/petroleum/supply/weekly/' },
    { claim: 'Reuters: prompt spread at a six-week high', url: 'https://www.reuters.com/markets/commodities/x' },
  ],
  no_trade_reason: null,
  ...overrides,
});

type Reply = Partial<NewsEstimate> | Error;

/**
 * A model that answers with `reply` (or throws it) and reports each call. `reply` may be a
 * function, for an answer that changes from one cycle to the next.
 */
function fakeLlm(
  reply: Reply | (() => Reply),
  onCall: (args: GenerateJsonArgs<unknown>) => void = () => {},
  completion: Partial<LlmCompletion> = {},
): Llm {
  return {
    model: 'fake-model',
    async generateJson<T>(args: GenerateJsonArgs<T>): Promise<T> {
      onCall(args as GenerateJsonArgs<unknown>);
      const next = typeof reply === 'function' ? reply() : reply;
      if (next instanceof Error) throw next;
      const value = args.schema.parse(estimate(next));
      await args.onCompletion?.({
        text: JSON.stringify(value),
        model: 'fake-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        ...completion,
      });
      return value;
    },
  };
}

interface Call {
  id: ModelId;
  args: GenerateJsonArgs<unknown>;
}

/** Every roster model; each answers `replies[id]`, or 0.6 (no edge) when not given. */
function arena(replies: Partial<Record<ModelId, Reply | (() => Reply)>> = {}, calls: Call[] = []): ArenaContender[] {
  return ARENA_ROSTER.map((entrant) => ({
    entrant,
    llm: fakeLlm(replies[entrant.id] ?? {}, (args) => calls.push({ id: entrant.id, args })),
  }));
}

/** Replies in order, one per call. */
const inTurn = (replies: Reply[]) => () => {
  const next = replies.shift();
  if (next === undefined) throw new Error('no reply scripted');
  return next;
};

let db: Db;
let close: () => Promise<void>;
let enabled: boolean;
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  enabled = true;
});
afterEach(() => close());

const cycle = (contenders: ArenaContender[], now = NOW) =>
  runArenaCycle({ db, contenders, tradingEnabled: () => enabled, logger, now: () => now });

async function thesisAuthorKeys(db: Db): Promise<string[]> {
  const rows = await db.select({ key: authors.agentKey }).from(theses).innerJoin(authors, eq(authors.id, theses.authorId));
  return rows.map((r) => r.key!).sort();
}

async function haltedKeys(db: Db): Promise<string[]> {
  const rows = await db.select().from(agentState).where(eq(agentState.halted, true));
  return rows.map((r) => r.agentKey).sort();
}

const result = (out: Awaited<ReturnType<typeof runArenaCycle>>, id: ModelId) => out.results.find((r) => r.id === id);
const runsOf = (agentKey: string) => db.select().from(agentRuns).where(eq(agentRuns.agentKey, agentKey));

describe('runArenaCycle', () => {
  it('asks every model about the same market with the identical prompt', async () => {
    const { id: marketId } = await upsertMarket(db, market());
    const seen: string[] = [];
    const contenders = ARENA_ROSTER.map((entrant) => ({
      entrant,
      llm: fakeLlm({ probability_yes: 0.5 }, (args) => seen.push(args.user)),
    }));
    const out = await cycle(contenders);
    expect(new Set(seen).size).toBe(1);
    expect(seen).toHaveLength(ARENA_ROSTER.length);
    expect(out.results).toHaveLength(ARENA_ROSTER.length);
    expect(out.market).toBe('GEMI-BRENT2611182200-HI90');
    // The market is data, and every run is logged against it.
    expect(seen[0]).toContain('<data name="market">');
    const runs = await db.select().from(agentRuns);
    expect(runs.map((r) => r.agentKey).sort()).toEqual(ARENA_ROSTER.map((e) => e.agentKey).sort());
    expect(runs.every((r) => r.marketId === marketId)).toBe(true);
  });

  it('gives each model its own purpose, the same system prompt, and web search', async () => {
    await upsertMarket(db, market());
    const calls: Call[] = [];
    await cycle(arena({}, calls));
    expect(calls.map((c) => c.args.purpose).sort()).toEqual(ARENA_ROSTER.map((e) => `arena:${e.id}`).sort());
    expect(new Set(calls.map((c) => c.args.system)).size).toBe(1);
    expect(calls.every((c) => c.args.useSearch === true)).toBe(true);
  });

  it('a model with enough edge trades under its own author', async () => {
    const { id: marketId } = await upsertMarket(db, market());
    const out = await cycle(arena({ gpt: { probability_yes: 0.9 } }));
    expect(await thesisAuthorKeys(db)).toEqual(['arena-gpt']);
    expect(result(out, 'gpt')).toMatchObject({ decision: 'trade' });
    expect(out.results.filter((r) => r.decision === 'trade')).toHaveLength(1);

    // Side and limit decided in code: 90% against a 62¢ ask keeps 10 points at 80¢.
    const [thesis] = await db.select().from(theses);
    expect(thesis).toMatchObject({ status: 'auditing', marketId, side: 'yes', probabilityYes: '0.9000' });
    const [trade] = await db.select().from(trades);
    expect(trade).toMatchObject({ status: 'pending', price: '0.8000', costUsd: '10.0000', isAuthorPosition: true });
    const [run] = await runsOf('arena-gpt');
    expect(run).toMatchObject({ decision: 'trade', error: null });
    expect(run!.signal).toMatchObject({ probabilityYes: 0.9, side: 'yes', limitPrice: '0.80', thesisId: thesis!.id });

    const [author] = await db.select().from(authors).where(eq(authors.agentKey, 'arena-gpt'));
    expect(author).toMatchObject({ kind: 'agent', displayName: 'GPT-5' });
  });

  it('then the pipeline audits, fills on that model’s own ledger and publishes', async () => {
    await upsertMarket(db, market());
    await cycle(arena({ claude: { probability_yes: 0.9 } }));
    const CLEAN = JSON.stringify({ inside_info: false, inside_info_quote: null, prohibited: 'none', claims: [] });
    const auditor = createLlm({
      provider: {
        model: 'test-model',
        async complete(_request: LlmRequest): Promise<LlmCompletion> {
          return { text: CLEAN, model: 'test-model', usage: { inputTokens: 10, outputTokens: 5 } };
        },
      },
    });
    const pipeline = createThesisPipeline({ db, llm: auditor, tradingEnabled: () => true, logger, now: () => NOW });
    expect(await pipeline.runCycle()).toMatchObject({ published: 1 });
    expect((await db.select().from(agentState))[0]).toMatchObject({ agentKey: 'arena-claude', tradeCount: 1 });
  });

  it('one model failing does not stop the others', async () => {
    await upsertMarket(db, market());
    const out = await cycle(arena({ grok: new LlmError('provider', 'HTTP 503'), claude: { probability_yes: 0.9 } }));
    expect(result(out, 'grok')).toMatchObject({ decision: 'skip', reason: 'The model call failed.' });
    expect(await thesisAuthorKeys(db)).toContain('arena-claude');
    const [run] = await runsOf('arena-grok');
    expect(run!.error).toContain('503');
  });

  /** An answer that skipped validation: acting on it throws after the model was paid. */
  const brokenAnswer = <T>() => ({ ...estimate(), evidence: undefined }) as unknown as T;

  it('a failure after the model answered is logged against the market, and does not stop the others', async () => {
    const { id: marketId } = await upsertMarket(db, market());
    const broken: Llm = { model: 'fake-model', generateJson: async <T>() => brokenAnswer<T>() };
    const contenders = arena({ claude: { probability_yes: 0.9 } }).map((c) =>
      c.entrant.id === 'gemini' ? { ...c, llm: broken } : c,
    );
    const warnings: string[] = [];
    const out = await runArenaCycle({
      db,
      contenders,
      tradingEnabled: () => true,
      logger: { ...logger, warn: (line: string) => warnings.push(line) },
      now: () => NOW,
    });
    expect(result(out, 'gemini')).toMatchObject({ decision: 'skip', reason: 'The trade could not be submitted.' });
    expect(result(out, 'claude')).toMatchObject({ decision: 'trade' });
    expect(await thesisAuthorKeys(db)).toEqual(['arena-claude']);

    const [run] = await runsOf('arena-gemini');
    expect(run).toMatchObject({ marketId, decision: 'skip', reason: 'The trade could not be submitted.' });
    expect(run!.error).toEqual(expect.any(String));
    // The model did answer: its probability is kept.
    expect(run!.signal).toMatchObject({ probabilityYes: 0.6 });
    expect(warnings.join('\n')).toContain('gemini');
  });

  it('a failure after the model answered is not a model error toward the halt', async () => {
    await upsertMarket(db, market());
    const fail = new LlmError('provider', 'HTTP 500');
    // Four model errors, one answer that cannot be acted on, four more model errors.
    const turns: Array<'fail' | 'broken'> = ['fail', 'fail', 'fail', 'fail', 'broken', 'fail', 'fail', 'fail', 'fail'];
    const flaky: Llm = {
      model: 'fake-model',
      generateJson: async <T>() => {
        if (turns.shift() === 'fail') throw fail;
        return brokenAnswer<T>();
      },
    };
    const contenders = arena().map((c) => (c.entrant.id === 'grok' ? { ...c, llm: flaky } : c));
    for (let i = 0; i < 9; i += 1) await cycle(contenders, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
    // Nor does a run of them halt on its own.
    const broken: Llm = { model: 'fake-model', generateJson: async <T>() => brokenAnswer<T>() };
    const always = arena().map((c) => (c.entrant.id === 'grok' ? { ...c, llm: broken } : c));
    for (let i = 9; i < 15; i += 1) await cycle(always, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
    expect((await runsOf('arena-grok')).filter((r) => r.reason === 'The trade could not be submitted.')).toHaveLength(7);
  });

  it('a model refused by its budget logs a budget skip', async () => {
    await upsertMarket(db, market());
    const out = await cycle(
      arena({ gpt: new LlmError('budget', 'The daily language-model cap of 1000 tokens is reached.'), claude: { probability_yes: 0.9 } }),
    );
    expect(result(out, 'gpt')).toMatchObject({ decision: 'skip', reason: expect.stringContaining('daily') });
    expect(await thesisAuthorKeys(db)).not.toContain('arena-gpt');
    const [run] = await runsOf('arena-gpt');
    expect(run).toMatchObject({ decision: 'skip', error: null });
  });

  it('a model that answers without searching does not trade', async () => {
    await upsertMarket(db, market());
    const calls: Call[] = [];
    const ungrounded = new LlmError('ungrounded', 'The language model answered without searching the web.');
    const contenders = arena({ gpt: ungrounded }, calls);
    const out = await cycle(contenders);
    expect(calls.find((c) => c.id === 'gpt')!.args.requireSearch).toBe(true);
    expect(result(out, 'gpt')).toMatchObject({
      decision: 'skip',
      reason: 'It answered without searching the web, so it did not trade.',
    });
    expect(await thesisAuthorKeys(db)).not.toContain('arena-gpt');
    const [run] = await runsOf('arena-gpt');
    expect(run!.error).toContain('without searching');

    // Five in a row halt the model for the day, like any other failed call.
    for (let i = 1; i < 4; i += 1) await cycle(contenders, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
    const fifth = await cycle(contenders, new Date(NOW.getTime() + 4 * 60_000));
    expect(await haltedKeys(db)).toEqual(['arena-gpt']);
    expect(result(fifth, 'gpt')!.reason).toContain('5 times in a row');
  });

  it('five consecutive errors halt only that model', async () => {
    await upsertMarket(db, market());
    const calls: Call[] = [];
    const contenders = arena({ grok: new LlmError('provider', 'HTTP 500') }, calls);
    for (let i = 0; i < 4; i += 1) await cycle(contenders, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
    const fifth = await cycle(contenders, new Date(NOW.getTime() + 4 * 60_000));
    expect(await haltedKeys(db)).toEqual(['arena-grok']);
    expect(result(fifth, 'grok')!.reason).toContain('5 times in a row');
    const [state] = await db.select().from(agentState).where(eq(agentState.agentKey, 'arena-grok'));
    expect(state).toMatchObject({ day: '2026-11-18', halted: true, haltReason: 'consecutive model errors' });

    // Halted: not asked again today, while the others still are.
    calls.length = 0;
    const sixth = await cycle(contenders, new Date(NOW.getTime() + 5 * 60_000));
    expect(result(sixth, 'grok')).toMatchObject({ decision: 'skip', reason: 'Halted: consecutive model errors.' });
    expect(calls.map((c) => c.id)).not.toContain('grok');
    expect(calls).toHaveLength(ARENA_ROSTER.length - 1);
  });

  it('a successful look starts the count again', async () => {
    await upsertMarket(db, market());
    const fail = new LlmError('provider', 'HTTP 500');
    const contenders = arena({ grok: inTurn([fail, fail, fail, fail, {}, fail, fail, fail, fail]) });
    for (let i = 0; i < 9; i += 1) await cycle(contenders, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
  });

  it('budget refusals never count as errors toward the halt', async () => {
    await upsertMarket(db, market());
    const contenders = arena({ gpt: new LlmError('budget', 'The daily language-model spend cap of $25.00 is reached.') });
    for (let i = 0; i < 6; i += 1) await cycle(contenders, new Date(NOW.getTime() + i * 60_000));
    expect(await haltedKeys(db)).toEqual([]);
    expect((await runsOf('arena-gpt')).every((r) => r.error === null)).toBe(true);
  });

  it('keeps Google’s search suggestions with the run that used them', async () => {
    await upsertMarket(db, market());
    const contenders = arena().map((c) =>
      c.entrant.id === 'gemini' ? { ...c, llm: fakeLlm({}, () => {}, { searchSuggestionsHtml: '<div class="chips">brent</div>' }) } : c,
    );
    await cycle(contenders);
    const [gemini] = await runsOf('arena-gemini');
    expect(gemini!.signal).toMatchObject({ searchSuggestionsHtml: '<div class="chips">brent</div>' });
    const [claude] = await runsOf('arena-claude');
    expect(claude!.signal).not.toHaveProperty('searchSuggestionsHtml');
  });

  it('a halted model is not asked; the others are', async () => {
    await upsertMarket(db, market());
    await db.insert(agentState).values({ agentKey: 'arena-claude', day: '2026-11-18', halted: true, haltReason: 'daily loss stop' });
    const calls: Call[] = [];
    const out = await cycle(arena({}, calls));
    expect(result(out, 'claude')).toMatchObject({ decision: 'skip', reason: 'Halted: daily loss stop.' });
    expect(calls.map((c) => c.id).sort()).toEqual(['deepseek', 'gemini', 'gpt', 'grok']);
  });

  it('a model waiting on the auditor, or already holding the market, is not asked; the others are', async () => {
    await upsertMarket(db, market());
    await cycle(arena({ gpt: { probability_yes: 0.9 } }));

    const waiting: Call[] = [];
    const second = await cycle(arena({}, waiting), new Date(NOW.getTime() + 60_000));
    expect(result(second, 'gpt')!.reason).toContain('auditor');
    expect(waiting.map((c) => c.id)).not.toContain('gpt');
    expect(waiting).toHaveLength(ARENA_ROSTER.length - 1);

    await db.update(theses).set({ status: 'published' });
    const holding: Call[] = [];
    const third = await cycle(arena({}, holding), new Date(NOW.getTime() + 2 * 60_000));
    expect(result(third, 'gpt')!.reason).toContain('Already holds');
    expect(holding.map((c) => c.id)).not.toContain('gpt');
    expect(holding).toHaveLength(ARENA_ROSTER.length - 1);
  });

  it('picks the market any arena model looked at least recently', async () => {
    const { id: a } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-A' }));
    const { id: b } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-B' }));
    const { id: c } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-C' }));
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    await db.insert(agentRuns).values([
      { agentKey: 'arena-claude', marketId: a, decision: 'skip', createdAt: hoursAgo(3) },
      { agentKey: 'arena-gpt', marketId: b, decision: 'skip', createdAt: hoursAgo(2) },
      // Another agent's look does not count.
      { agentKey: 'news', marketId: c, decision: 'skip', createdAt: hoursAgo(1) },
    ]);
    expect((await cycle(arena())).market).toBe('GEMI-C');
    expect((await cycle(arena(), new Date(NOW.getTime() + 60_000))).market).toBe('GEMI-A');
    expect((await cycle(arena(), new Date(NOW.getTime() + 2 * 60_000))).market).toBe('GEMI-B');
  });

  it('does not look at short crypto windows, one-sided books, or markets about to close', async () => {
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-BTC15M2611180515-UP', eventTicker: 'BTC15M2611180515', expiryAt: new Date('2026-11-18T08:00:00Z') }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-ONE-SIDED', yesBid: null }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-CLOSING', expiryAt: new Date(NOW.getTime() + 20 * 60_000) }));
    const calls: Call[] = [];
    const out = await cycle(arena({}, calls));
    expect(out.market).toBeNull();
    expect(calls).toHaveLength(0);
    expect(out.results).toHaveLength(ARENA_ROSTER.length);
    expect(out.results.every((r) => r.decision === 'skip')).toBe(true);
  });

  it('asks no model when trading is off', async () => {
    await upsertMarket(db, market());
    enabled = false;
    const calls: Call[] = [];
    const out = await cycle(arena({ gpt: { probability_yes: 0.9 } }, calls));
    expect(calls).toHaveLength(0);
    expect(out.results.every((r) => r.decision === 'skip' && r.reason === 'Trading is switched off.')).toBe(true);
    expect(await db.select().from(agentRuns)).toHaveLength(ARENA_ROSTER.length);
  });

  it('runs only the contenders it is given', async () => {
    await upsertMarket(db, market());
    const out = await cycle(arena().filter((c) => c.entrant.id !== 'grok'));
    expect(out.results.map((r) => r.id)).not.toContain('grok');
    expect(await runsOf('arena-grok')).toHaveLength(0);
  });
});
