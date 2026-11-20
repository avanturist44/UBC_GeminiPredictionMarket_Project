import type { LlmProvider } from '@thesis/core';
import { llmTokensSince, recordLlmCall, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withSpendCap } from '../src/llm';
import { createSpendGuard } from '../src/llm/spend-guard';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const fakeProvider = (): LlmProvider => ({
  model: 'fake',
  complete: async () => ({ text: '{"ok":true}', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } }),
});
const args = (purpose: string) => ({ purpose, system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });

let db: Db;
let close: () => Promise<void>;
/** A dollar cap far above anything these tests spend: only the token caps are under test here. */
let guard: ReturnType<typeof createSpendGuard>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  guard = createSpendGuard({ db, dailyCapUsd: 1000, logger });
});
afterEach(() => close());

const call = (purpose: string, inputTokens: number) =>
  recordLlmCall(db, { purpose, model: 'm', inputTokens, outputTokens: 0, costUsd: '0' });

describe('withSpendCap provider flags', () => {
  it("the spend cap keeps the provider's schema flag", async () => {
    const systems: string[] = [];
    const provider = (enforcesJsonSchema: boolean): LlmProvider => ({
      ...fakeProvider(),
      enforcesJsonSchema,
      complete: async (request) => {
        systems.push(request.system);
        return { text: '{"ok":true}', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    await withSpendCap(db, provider(true), { dailyTokenCap: 1000, guard, logger }).generateJson(args('a'));
    await withSpendCap(db, provider(false), { dailyTokenCap: 1000, guard, logger }).generateJson(args('a'));
    expect(systems[0]).not.toContain('Reply with a single JSON object');
    expect(systems[1]).toContain('Reply with a single JSON object');
  });
});

describe('withSpendCap scopes', () => {
  it("arena calls never count against the auditor's cap", async () => {
    await call('arena:gpt', 900);
    const auditor = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, excludePrefix: 'arena:', guard, logger });
    await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
    // More arena usage, past the cap: the auditor is still unaffected, an unscoped cap is not.
    await call('arena:claude', 200);
    await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
    const unscoped = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, guard, logger });
    await expect(unscoped.generateJson(args('audit-screen'))).rejects.toMatchObject({ code: 'budget' });
  });

  it("audits of arena theses count against neither the auditor's cap nor the model's own", async () => {
    await call('arena-audit:gpt:audit-check', 5_000);
    const auditor = withSpendCap(db, fakeProvider(), {
      dailyTokenCap: 1000,
      excludePrefix: ['arena:', 'arena-audit:'],
      guard,
      logger,
    });
    await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
    const gpt = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, purposePrefix: 'arena:gpt', guard, logger });
    await expect(gpt.generateJson(args('arena:gpt'))).resolves.toBeDefined();
    // The auditor's own calls still count against it.
    await call('audit-check', 1_000);
    await expect(auditor.generateJson(args('audit-screen'))).rejects.toMatchObject({ code: 'budget' });
  });

  it('a model at its own cap is refused while the others continue', async () => {
    await call('arena:gpt', 500);
    const gpt = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:gpt', guard, logger });
    const claude = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:claude', guard, logger });
    await expect(gpt.generateJson(args('arena:gpt'))).rejects.toMatchObject({ code: 'budget' });
    await expect(claude.generateJson(args('arena:claude'))).resolves.toBeDefined();
  });

  it('matches a prefix literally, so % and _ are not wildcards', async () => {
    await call('arenaXgpt', 100);
    await call('arena:gpt', 7);
    const since = new Date(Date.now() - 60_000);
    expect(await llmTokensSince(db, since, { purposePrefix: 'arena_' })).toBe(0);
    expect(await llmTokensSince(db, since, { purposePrefix: '%' })).toBe(0);
    expect(await llmTokensSince(db, since, { excludePrefix: 'arena_' })).toBe(107);
    expect(await llmTokensSince(db, since, { purposePrefix: 'arena:' })).toBe(7);
    expect(await llmTokensSince(db, since)).toBe(107);
  });

  it('gives a search call searchTimeoutMs when set, and the usual 120 seconds when not', async () => {
    const limits: number[] = [];
    const timed: LlmProvider = {
      model: 'fake',
      complete: async (request) => {
        limits.push(request.timeoutMs);
        return { text: '{"ok":true}', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const search = { ...args('arena:gpt'), useSearch: true };
    await withSpendCap(db, timed, { dailyTokenCap: 1000, searchTimeoutMs: 180_000, guard, logger }).generateJson(search);
    await withSpendCap(db, timed, { dailyTokenCap: 1000, guard, logger }).generateJson(search);
    expect(limits).toEqual([180_000, 120_000]);
  });

  it('cannot be built without the dollar guard, so no model client goes uncapped', () => {
    // @ts-expect-error the guard is required
    expect(() => withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, logger })).toThrow(/guard/);
  });
});
