import { LlmError, type LlmCompletion, type LlmProvider } from '@thesis/core';
import { llmCalls, llmCostSince, recordLlmCall, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withSpendCap } from '../src/llm';
import { createSpendGuard } from '../src/llm/spend-guard';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
/** The worst single call on this model costs 0.12 + 0.16 + 0.05 = $0.33. */
const SONNET = 'claude-sonnet-5-5';
const DAY_MS = 24 * 60 * 60 * 1000;
const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const spent = (costUsd: string) =>
  recordLlmCall(db, { purpose: 'audit-check', model: SONNET, inputTokens: 1, outputTokens: 1, costUsd });

describe('createSpendGuard', () => {
  it("refuses a call once the day's spend plus its worst case would pass the cap", async () => {
    await spent('0.80');
    const guard = createSpendGuard({ db, dailyCapUsd: 1, logger });
    await expect(guard.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' }); // 0.80 + 0.33 > 1
    await expect(guard.reserve(SONNET)).rejects.toBeInstanceOf(LlmError);
  });

  it('counts calls still in flight', async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 1, logger });
    for (let i = 0; i < 3; i += 1) await guard.reserve(SONNET); // 3 × 0.33 = 0.99
    await expect(guard.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' });
  });

  it('settling frees the reservation and the recorded cost is what counts', async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 0.5, logger });
    const call = await guard.reserve(SONNET);
    await expect(guard.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' }); // 0.33 + 0.33 > 0.5
    await spent('0.12');
    call.settle(0.12);
    expect(await llmCostSince(db, startOfToday())).toBeCloseTo(0.12, 6);
    await expect(guard.reserve(SONNET)).resolves.toBeDefined(); // 0.12 + 0.33 <= 0.5
  });

  it("yesterday's spend does not count", async () => {
    await spent('5');
    // The guard's clock is a day ahead, so the $5 above was spent on its yesterday.
    const guard = createSpendGuard({ db, dailyCapUsd: 1, logger, now: () => new Date(Date.now() + DAY_MS) });
    await expect(guard.reserve(SONNET)).resolves.toBeDefined();
    const today = createSpendGuard({ db, dailyCapUsd: 1, logger });
    await expect(today.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' });
  });

  it("still counts a call that ended while the day's spend was being read", async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 0.5, logger });
    const first = await guard.reserve(SONNET);
    const second = guard.reserve(SONNET); // reading the day's spend
    // The first call ends now; its row may not be in what the second read sees.
    first.settle(0.33);
    await expect(second).rejects.toMatchObject({ code: 'budget' });
  });

  it('settles each reservation once, and a cost that is not a number does not break the count', async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 0.5, logger });
    const call = await guard.reserve(SONNET);
    call.settle(0);
    call.settle(0); // a second settle must not free room the guard never held
    const next = await guard.reserve(SONNET);
    await expect(guard.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' });
    next.settle(Number.NaN);
    await guard.reserve(SONNET);
    await expect(guard.reserve(SONNET)).rejects.toMatchObject({ code: 'budget' });
  });

  it('warns when a call cost more than was held for it', async () => {
    const warnings: string[] = [];
    const guard = createSpendGuard({ db, dailyCapUsd: 25, logger: { ...logger, warn: (m: string) => void warnings.push(m) } });
    (await guard.reserve(SONNET)).settle(0.2);
    expect(warnings).toEqual([]);
    (await guard.reserve(SONNET)).settle(0.5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SONNET);
  });
});

/** A provider that answers from `reply`, and counts the calls that reached it. */
function scripted(model: string, reply: () => Promise<LlmCompletion>) {
  let calls = 0;
  const provider: LlmProvider = {
    model,
    complete: () => {
      calls += 1;
      return reply();
    },
  };
  return { provider, calls: () => calls };
}

const answer = (overrides: Partial<LlmCompletion> = {}) => async (): Promise<LlmCompletion> => ({
  text: '{"ok":true}',
  model: SONNET,
  usage: { inputTokens: 38_000, outputTokens: 1_600 },
  searches: 3,
  ...overrides,
});
const args = (useSearch = true) => ({ purpose: 'news', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), useSearch });
const rows = () => db.select().from(llmCalls);

describe('withSpendCap with the dollar guard', () => {
  it('records what each call cost', async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 25, logger });
    const { provider } = scripted(SONNET, answer());
    await withSpendCap(db, provider, { dailyTokenCap: 10_000_000, guard, logger }).generateJson(args());
    expect(await rows()).toMatchObject([{ purpose: 'news', model: SONNET, inputTokens: 38_000, outputTokens: 1_600, costUsd: '0.122000' }]);
  });

  it('refuses a call over the dollar cap without calling the model', async () => {
    await spent('24.80');
    const guard = createSpendGuard({ db, dailyCapUsd: 25, logger });
    const { provider, calls } = scripted(SONNET, answer());
    const llm = withSpendCap(db, provider, { dailyTokenCap: 10_000_000, guard, logger });
    await expect(llm.generateJson(args())).rejects.toMatchObject({ code: 'budget' });
    expect(calls()).toBe(0);
  });

  it('a failed call frees its reservation', async () => {
    // Room for one call at a time.
    const guard = createSpendGuard({ db, dailyCapUsd: 0.5, logger });
    const { provider } = scripted(SONNET, async () => {
      throw new Error('socket hang up');
    });
    const llm = withSpendCap(db, provider, { dailyTokenCap: 10_000_000, guard, logger });
    await expect(llm.generateJson(args())).rejects.toMatchObject({ code: 'provider' });
    const timedOut = scripted(SONNET, async () => {
      throw new LlmError('timeout', 'The language model did not answer in time.');
    });
    await expect(
      withSpendCap(db, timedOut.provider, { dailyTokenCap: 10_000_000, guard, logger }).generateJson(args()),
    ).rejects.toMatchObject({ code: 'timeout' });
    // Nothing was spent and nothing is still held.
    expect(await rows()).toEqual([]);
    await expect(guard.reserve(SONNET)).resolves.toBeDefined();
  });

  it('prices and records a failed call that used tokens, counting the most searches', async () => {
    const guard = createSpendGuard({ db, dailyCapUsd: 0.5, logger });
    const { provider } = scripted(SONNET, async () => {
      throw new LlmError('refused', 'The language model declined the request.', { inputTokens: 10_000, outputTokens: 1_000 });
    });
    const llm = withSpendCap(db, provider, { dailyTokenCap: 10_000_000, guard, logger });
    await expect(llm.generateJson(args())).rejects.toMatchObject({ code: 'refused' });
    // 0.02 + 0.01 + 5 searches at 0.01: the error does not say how many searches ran.
    expect(await rows()).toMatchObject([{ costUsd: '0.080000' }]);
    expect(await llmCostSince(db, startOfToday())).toBeCloseTo(0.08, 6);
    await expect(guard.reserve(SONNET)).resolves.toBeDefined(); // 0.08 + 0.33 <= 0.5
  });

  it('assumes the most searches when a search call does not say, and none when search was off', async () => {
    const { provider } = scripted(SONNET, answer({ searches: undefined, usage: { inputTokens: 0, outputTokens: 0 } }));
    const llm = withSpendCap(db, provider, { dailyTokenCap: 10_000_000, logger });
    await llm.generateJson(args(true));
    await llm.generateJson(args(false));
    expect((await rows()).map((row) => row.costUsd).sort()).toEqual(['0.000000', '0.050000']);
  });

  it('prices by the model that served the call', async () => {
    const { provider } = scripted('gpt-5', answer({ model: 'gpt-5-2025-08-07', searches: 0 }));
    await withSpendCap(db, provider, { dailyTokenCap: 10_000_000, logger }).generateJson(args());
    // 38,000 × 1.25 + 1,600 × 10 per million.
    expect(await rows()).toMatchObject([{ model: 'gpt-5-2025-08-07', costUsd: '0.063500' }]);
  });
});
