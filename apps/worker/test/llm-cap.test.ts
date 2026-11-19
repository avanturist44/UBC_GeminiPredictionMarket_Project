import type { LlmProvider } from '@thesis/core';
import { llmTokensSince, recordLlmCall, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withSpendCap } from '../src/llm';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const fakeProvider = (): LlmProvider => ({
  model: 'fake',
  complete: async () => ({ text: '{"ok":true}', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } }),
});
const args = (purpose: string) => ({ purpose, system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const call = (purpose: string, inputTokens: number) =>
  recordLlmCall(db, { purpose, model: 'm', inputTokens, outputTokens: 0, costUsd: '0' });

describe('withSpendCap scopes', () => {
  it("arena calls never count against the auditor's cap", async () => {
    await call('arena:gpt', 900);
    const auditor = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, excludePrefix: 'arena:', logger });
    await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
    // More arena usage, past the cap: the auditor is still unaffected, an unscoped cap is not.
    await call('arena:claude', 200);
    await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
    const unscoped = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, logger });
    await expect(unscoped.generateJson(args('audit-screen'))).rejects.toMatchObject({ code: 'budget' });
  });

  it('a model at its own cap is refused while the others continue', async () => {
    await call('arena:gpt', 500);
    const gpt = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:gpt', logger });
    const claude = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:claude', logger });
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
});
