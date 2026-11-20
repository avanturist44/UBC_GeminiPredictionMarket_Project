import { ARENA_ROSTER, type LlmProvider, type ModelId } from '@thesis/core';
import { recordLlmCall, type Db } from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { arenaProviders, checkServedModel, createArenaContenders, type ProviderFactory } from '../src/arena-contenders';
import { parseEnv } from '../src/env';
import { createSpendGuard, type SpendGuard } from '../src/llm/spend-guard';
import { fakeFetch, json, request } from './fake-fetch';

/** Made-up keys, one per provider, so a test can tell which one went where. */
const KEYS = {
  LLM_API_KEY: 'test-key-claude-0001',
  OPENAI_API_KEY: 'test-key-gpt-0002',
  GEMINI_API_KEY: 'test-key-gemini-0003',
  XAI_API_KEY: 'test-key-grok-0004',
  DEEPSEEK_API_KEY: 'test-key-deepseek-0005',
};
const env = parseEnv({ DATABASE_URL: 'postgres://localhost/test', ...KEYS });

const entrant = (id: ModelId) => ARENA_ROSTER.find((e) => e.id === id)!;
const ask = (purpose: string) => ({ purpose, system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) });

let db: Db;
let close: () => Promise<void>;
let logs: string[];
let logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
/** A dollar cap far above anything these tests spend. */
let guard: SpendGuard;
/** The key each entrant's provider was built with. */
let given: Map<ModelId, string>;
/** Calls each entrant's provider received. */
let answered: ModelId[];

const fakeFactory: ProviderFactory = (e, apiKey): LlmProvider => {
  given.set(e.id, apiKey);
  return {
    model: e.model,
    complete: async () => {
      answered.push(e.id);
      return { text: '{"ok":true}', model: e.model, usage: { inputTokens: 10, outputTokens: 1 }, searches: 1 };
    },
  };
};

describe('createArenaContenders', () => {
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    logs = [];
    const push = (message: string) => logs.push(message);
    logger = { info: push, warn: push, error: push };
    guard = createSpendGuard({ db, dailyCapUsd: 1000, logger });
    given = new Map();
    answered = [];
  });
  afterEach(() => close());

  it('leaves out entrants without a key, and says which', () => {
    const contenders = createArenaContenders({ ...env, OPENAI_API_KEY: undefined }, db, logger, guard, fakeFactory);
    expect(contenders.map((c) => c.entrant.id)).not.toContain('gpt');
    expect(logs.join('\n')).toContain('gpt');
  });

  it('with every key set, runs every roster model in roster order and logs nothing', () => {
    const contenders = createArenaContenders(env, db, logger, guard, fakeFactory);
    expect(contenders.map((c) => c.entrant.id)).toEqual(ARENA_ROSTER.map((e) => e.id));
    expect(logs).toEqual([]);
  });

  it('names every missing model and its variable in one line, and never a key', () => {
    const contenders = createArenaContenders(
      { ...env, XAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined },
      db,
      logger,
      guard,
      fakeFactory,
    );
    expect(contenders.map((c) => c.entrant.id)).toEqual(['gemini', 'claude', 'gpt']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/grok.*XAI_API_KEY/);
    expect(logs[0]).toMatch(/deepseek.*DEEPSEEK_API_KEY/);
    for (const key of Object.values(KEYS)) expect(logs[0]).not.toContain(key);
  });

  it('builds each model with its own key: Claude with LLM_API_KEY', () => {
    createArenaContenders(env, db, logger, guard, fakeFactory);
    expect(Object.fromEntries(given)).toEqual({
      gemini: KEYS.GEMINI_API_KEY,
      claude: KEYS.LLM_API_KEY,
      gpt: KEYS.OPENAI_API_KEY,
      grok: KEYS.XAI_API_KEY,
      deepseek: KEYS.DEEPSEEK_API_KEY,
    });
  });

  it("holds each model to its own daily token cap, counting its own calls only", async () => {
    const capped = { ...env, ARENA_DAILY_TOKEN_CAP_PER_MODEL: 100 };
    const record = (purpose: string, inputTokens: number) =>
      recordLlmCall(db, { purpose, model: 'm', inputTokens, outputTokens: 0, costUsd: '0' });
    await record('arena:gpt', 100);
    // The auditor's and the agents' calls are not an arena model's.
    await record('audit-check', 5_000);
    await record('news', 5_000);
    const byId = new Map(createArenaContenders(capped, db, logger, guard, fakeFactory).map((c) => [c.entrant.id, c.llm]));

    await expect(byId.get('gpt')!.generateJson(ask('arena:gpt'))).rejects.toMatchObject({ code: 'budget' });
    await expect(byId.get('claude')!.generateJson(ask('arena:claude'))).resolves.toEqual({ ok: true });
    expect(answered).toEqual(['claude']);
  });

  it('puts every model call through the one dollar guard it is given', async () => {
    const reserved: string[] = [];
    const shared: SpendGuard = {
      async reserve(model) {
        reserved.push(model);
        return { settle: () => {} };
      },
    };
    const contenders = createArenaContenders(env, db, logger, shared, fakeFactory);
    for (const { entrant: e, llm } of contenders) await llm.generateJson(ask(`arena:${e.id}`));
    expect(reserved).toEqual(ARENA_ROSTER.map((e) => e.model));
  });

  it('arena contenders get a 180-second search timeout', async () => {
    const limits = new Map<ModelId, number>();
    const timed: ProviderFactory = (e): LlmProvider => ({
      model: e.model,
      complete: async (sent) => {
        limits.set(e.id, sent.timeoutMs);
        return { text: '{"ok":true}', model: e.model, usage: { inputTokens: 10, outputTokens: 1 }, searches: 1 };
      },
    });
    const contenders = createArenaContenders(env, db, logger, guard, timed);
    for (const { entrant: e, llm } of contenders) await llm.generateJson({ ...ask(`arena:${e.id}`), useSearch: true });
    expect(Object.fromEntries(limits)).toEqual(Object.fromEntries(ARENA_ROSTER.map((e) => [e.id, 180_000])));
  });

  it('refuses every model once the day’s dollar cap is reached, before any call', async () => {
    const spent = createSpendGuard({ db, dailyCapUsd: 0.01, logger });
    const contenders = createArenaContenders(env, db, logger, spent, fakeFactory);
    for (const { entrant: e, llm } of contenders) {
      await expect(llm.generateJson(ask(`arena:${e.id}`))).rejects.toMatchObject({ code: 'budget' });
    }
    expect(answered).toEqual([]);
  });
});

describe('arenaProviders (the default factory)', () => {
  it('sends each model to its own provider, with its own key and search tool', async () => {
    const { fetch, calls } = fakeFetch(() => json(401, { error: { message: 'no' } }));
    const make = arenaProviders(fetch);
    const keyOf = { gemini: 'k-gemini', claude: 'k-claude', gpt: 'k-gpt', grok: 'k-grok', deepseek: 'k-deepseek' };
    for (const e of ARENA_ROSTER) {
      const provider = make(e, keyOf[e.id]);
      expect(provider.model).toBe(e.model);
      // Every request is refused (401): only what was sent is under test.
      await provider.complete(request({ useSearch: true })).catch(() => {});
    }
    expect(calls).toHaveLength(ARENA_ROSTER.length);
    const [gemini, claude, gpt, grok, deepseek] = calls;

    expect(gemini!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
    );
    expect(gemini!.headers.get('x-goog-api-key')).toBe('k-gemini');
    expect(gemini!.body.tools).toEqual([{ google_search: {} }]);

    expect(claude!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(claude!.headers.get('authorization')).toBe('Bearer k-claude');
    expect(claude!.body.model).toBe('claude-sonnet-5-5');

    // The Responses API: OpenAI bounds a call's searches with max_tool_calls, xAI with both.
    expect(gpt!.url).toBe('https://api.openai.com/v1/responses');
    expect(gpt!.headers.get('authorization')).toBe('Bearer k-gpt');
    expect(gpt!.body).toMatchObject({ model: 'gpt-5', max_tool_calls: 5 });
    expect(grok!.url).toBe('https://api.x.ai/v1/responses');
    expect(grok!.headers.get('authorization')).toBe('Bearer k-grok');
    expect(grok!.body).toMatchObject({ model: 'grok-4.7', max_tool_calls: 5, max_turns: 2, reasoning: { effort: 'low' } });

    // DeepSeek speaks the Anthropic API at its own address, with its own key and search tool.
    expect(deepseek!.url).toMatch(/^https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/);
    expect(deepseek!.headers.get('authorization')).toBe('Bearer k-deepseek');
    expect(deepseek!.body.tools).toEqual([{ type: 'deepseek_web_search', name: 'deepseek_web_search' }]);
  });

  it('gives the Anthropic-API models the logger, so a stray tool call is reported', async () => {
    const strayReply = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'web_fetch', input: { url: 'https://example.com' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, server_tool_use: { web_search_requests: 0 } },
    };
    const answer = { ...strayReply, content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' };
    const warned: string[] = [];
    const replies = [strayReply, answer, strayReply, answer];
    const { fetch } = fakeFetch(() => json(200, replies.shift()));
    const make = arenaProviders(fetch, { warn: (m) => void warned.push(m) });

    for (const id of ['claude', 'deepseek'] as const) {
      expect((await make(entrant(id), 'k').complete(request({ useSearch: true }))).text).toBe('{"ok":true}');
    }
    expect(warned).toHaveLength(2);
    for (const line of warned) expect(line).toContain('web_fetch');
  });
});

describe('checkServedModel', () => {
  it('verify fails when the served model differs from the roster', () => {
    expect(checkServedModel(entrant('gpt'), 'gpt-5-mini')).toMatchObject({ ok: false });
    expect(checkServedModel(entrant('gpt'), 'gpt-5-2025-08-07')).toEqual({ ok: true });
  });

  it('accepts the roster id itself, or with a version or date after it', () => {
    expect(checkServedModel(entrant('gemini'), 'gemini-3.1-pro-preview')).toEqual({ ok: true });
    expect(checkServedModel(entrant('claude'), 'claude-sonnet-5-5-20261001')).toEqual({ ok: true });
    expect(checkServedModel(entrant('grok'), 'grok-4.7-0709')).toEqual({ ok: true });
  });

  it('rejects another model, even one that starts the same way, and says which', () => {
    for (const served of ['gpt-5.1', 'gpt-5-pro', 'gpt-4o', '']) {
      expect(checkServedModel(entrant('gpt'), served)).toMatchObject({ ok: false });
    }
    const result = checkServedModel(entrant('deepseek'), 'deepseek-chat');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('deepseek-chat');
      expect(result.message).toContain('deepseek-flash');
    }
  });
});

describe('worker environment for the arena', () => {
  it('runs the arena by default, hourly, with 1,000,000 tokens per model a day', () => {
    const defaults = parseEnv({ DATABASE_URL: 'postgres://localhost/test' });
    expect(defaults.ENABLED_AGENTS).toBe('arena');
    expect(defaults.ARENA_INTERVAL_MINUTES).toBe(60);
    expect(defaults.ARENA_DAILY_TOKEN_CAP_PER_MODEL).toBe(1_000_000);
    expect([defaults.OPENAI_API_KEY, defaults.GEMINI_API_KEY, defaults.XAI_API_KEY, defaults.DEEPSEEK_API_KEY]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("gives the arena $18 of the day's $25, and never more than the day's cap", () => {
    const base = { DATABASE_URL: 'postgres://localhost/test' };
    const defaults = parseEnv(base);
    expect([defaults.ARENA_DAILY_USD_CAP, defaults.LLM_DAILY_USD_CAP]).toEqual([18, 25]);
    expect(parseEnv({ ...base, ARENA_DAILY_USD_CAP: '' }).ARENA_DAILY_USD_CAP).toBe(18);
    expect(parseEnv({ ...base, ARENA_DAILY_USD_CAP: '25' }).ARENA_DAILY_USD_CAP).toBe(25);
    expect(() => parseEnv({ ...base, ARENA_DAILY_USD_CAP: '26' })).toThrow(/ARENA_DAILY_USD_CAP.*LLM_DAILY_USD_CAP/);
    // Lowering the day's cap below the arena's default needs the arena's lowered too.
    expect(() => parseEnv({ ...base, LLM_DAILY_USD_CAP: '10' })).toThrow(/ARENA_DAILY_USD_CAP/);
    expect(parseEnv({ ...base, LLM_DAILY_USD_CAP: '10', ARENA_DAILY_USD_CAP: '6' }).ARENA_DAILY_USD_CAP).toBe(6);
  });

  it('treats a blank key as not set, and looks no more often than every 15 minutes', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://localhost/test', OPENAI_API_KEY: '' }).OPENAI_API_KEY).toBeUndefined();
    expect(parseEnv({ DATABASE_URL: 'postgres://localhost/test', ARENA_INTERVAL_MINUTES: '15' }).ARENA_INTERVAL_MINUTES).toBe(15);
    expect(() => parseEnv({ DATABASE_URL: 'postgres://localhost/test', ARENA_INTERVAL_MINUTES: '10' })).toThrow(
      /ARENA_INTERVAL_MINUTES/,
    );
  });
});
