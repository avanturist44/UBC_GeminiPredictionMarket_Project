import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';
import { accountGroups, createSandboxAccount, createSandboxAccounts } from '../src/sandbox-account';
import { SandboxRefused } from '../src/sandbox-mirror';
import { eventWith, fakeGemini, filled, json, refusal, type Reply } from './fake-gemini';

const SYMBOL = 'GEMI-BTC15M2611180500-UP';
const EVENT = 'BTC15M2611180500';
const TRADE_ID = '6f1c2a40-8f8e-4d55-9a57-2f0f6f0b6b51';
const KEYS = { apiKey: 'account-test-key', apiSecret: 'test-secret' };
const event = eventWith(SYMBOL);
const order = { symbol: SYMBOL, side: 'no' as const, quantity: '10', price: '0.47', clientOrderId: TRADE_ID };

describe('createSandboxAccount', () => {
  it("buys at the sandbox's ask for the side, immediate-or-cancel, on the sandbox host", async () => {
    const gemini = fakeGemini({
      [`GET /v1/prediction-markets/events/${EVENT}`]: () => event,
      'POST /v1/prediction-markets/order': filled,
    });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    expect(await account.ask(SYMBOL, 'yes')).toBe('0.55');
    expect(await account.ask(SYMBOL, 'no')).toBe('0.47');
    expect(await account.place(order)).toEqual({ orderId: '145853902320985497', filledQuantity: '10', avgPrice: '0.47' });

    const placed = gemini.sent.find((s) => s.url.endsWith('/v1/prediction-markets/order'))!;
    expect(placed.body).toEqual({
      symbol: SYMBOL,
      orderType: 'limit',
      side: 'buy',
      outcome: 'no',
      quantity: '10',
      price: '0.47',
      timeInForce: 'immediate-or-cancel',
      makerOrCancel: false,
      clientOrderId: TRADE_ID,
    });
    expect(placed.payload).toMatchObject({ request: '/v1/prediction-markets/order', clientOrderId: TRADE_ID });
    // The ask is public: read without signing.
    expect(gemini.sent[0]!.payload).toBeNull();
    expect(gemini.sent.every((s) => s.url.startsWith('https://api.sandbox.gemini.com/'))).toBe(true);
  });

  it('has no ask for a contract the sandbox does not list or nobody is selling', async () => {
    const gemini = fakeGemini({
      [`GET /v1/prediction-markets/events/${EVENT}`]: () => json(200, { ticker: EVENT, contracts: [{ instrumentSymbol: SYMBOL, prices: null }] }),
    });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    expect(await account.ask(SYMBOL, 'yes')).toBeNull();
    expect(await account.ask('GEMI-RECESSION26-2026', 'yes')).toBeNull();
    expect(await account.ask('GEMI-BTC15M2611180500-HI90', 'yes')).toBeNull();
  });

  it('turns a refusal into SandboxRefused and passes a network failure on', async () => {
    const replies: Reply[] = [
      refusal(406, 'InsufficientFunds'),
      refusal(400, 'InvalidOrder'),
      refusal(429, 'RateLimited'),
      // A rejected nonce means the order was never looked at, so asking again is safe.
      refusal(400, 'InvalidNonce'),
      new TypeError('fetch failed'),
    ];
    const gemini = fakeGemini({ 'POST /v1/prediction-markets/order': () => replies.shift()! });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => 'placed',
        (error: unknown) => (error instanceof SandboxRefused ? `refused: ${error.code}` : 'no answer'),
      );

    expect(await outcome(account.place(order))).toBe('refused: insufficient_funds');
    expect(await outcome(account.place(order))).toBe('refused: invalid_request');
    expect(await outcome(account.place(order))).toBe('no answer');
    expect(await outcome(account.place(order))).toBe('no answer');
    expect(await outcome(account.place(order))).toBe('no answer');
  });

  it("finds an order by its client order id in the account's history", async () => {
    const gemini = fakeGemini({
      'POST /v1/prediction-markets/orders/history': () => ({
        status: 200,
        body:
          '{"orders":[{"orderId":1,"clientOrderId":"someone-else","filledQuantity":"1"},' +
          `{"orderId":2,"clientOrderId":"${TRADE_ID}","status":"cancelled","filledQuantity":"4","avgExecutionPrice":"0.5"}]}`,
      }),
    });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    expect(await account.findByClientOrderId(TRADE_ID)).toEqual({ orderId: '2', filledQuantity: '4', avgPrice: '0.5' });
    expect(await account.findByClientOrderId('never-placed')).toBeNull();
    expect(gemini.sent[0]!.payload).toMatchObject({ request: '/v1/prediction-markets/orders/history', limit: 1000 });
  });

  it('makes one call at a time, each signed request with a nonce second of its own and never ahead of the clock', async () => {
    const gemini = fakeGemini({
      'POST /v1/prediction-markets/order': filled,
      'POST /v1/prediction-markets/orders/history': () => json(200, { orders: [] }),
    });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    await Promise.all([
      account.place(order),
      account.findByClientOrderId(TRADE_ID),
      account.place({ ...order, clientOrderId: 'second' }),
    ]);
    expect(gemini.mostAtOnce()).toBe(1);
    const nonces = gemini.sent.map((s) => s.payload?.nonce);
    expect(new Set(nonces).size).toBe(3);
    // Gemini takes a time-based nonce within 30 seconds of its clock. One that ran ahead with every
    // call would, after enough calls, be refused for every request.
    for (const s of gemini.sent) expect(Number(s.payload?.nonce)).toBeLessThanOrEqual(Math.floor(s.at / 1000));
  });

  it('reads terms and available USD, and accepts nothing', async () => {
    const gemini = fakeGemini({
      'GET /v1/prediction-markets/terms/status': () => json(200, { hasAcceptedLatest: false, acceptedVersion: null, latestVersion: 3 }),
      'POST /v1/balances': () =>
        json(200, [
          { type: 'exchange', currency: 'BTC', amount: 1, available: 1 },
          { type: 'exchange', currency: 'USD', amount: 300, available: 250 },
        ]),
    });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    expect(await account.check()).toEqual({ termsAccepted: false, availableUsd: '250', balanceError: null });
    expect(gemini.sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'GET /v1/prediction-markets/terms/status',
      'POST /v1/balances',
    ]);
  });

  it('reports a rejected key as a refusal', async () => {
    const gemini = fakeGemini({ 'GET /v1/prediction-markets/terms/status': () => refusal(401, 'InvalidSignature') });
    const account = await createSandboxAccount(KEYS, { fetch: gemini.fetch });

    await expect(account.check()).rejects.toMatchObject({ name: 'SandboxRefused', code: 'authentication_failed' });
  });
});

describe('createSandboxAccounts', () => {
  it('gives agents that share a key one account', async () => {
    const other = { apiKey: 'account-other', apiSecret: 'other-secret' };
    const accounts = await createSandboxAccounts({ 'arena-gpt': KEYS, 'arena-claude': KEYS, 'arena-grok': other });

    expect(accounts.get('arena-gpt')).toBe(accounts.get('arena-claude'));
    expect(accounts.get('arena-grok')).not.toBe(accounts.get('arena-gpt'));
    expect(accountGroups(accounts).map((g) => g.agentKeys)).toEqual([['arena-gpt', 'arena-claude'], ['arena-grok']]);
  });
});

describe('GEMINI_AGENT_KEYS', () => {
  const env = (value?: string) => parseEnv({ DATABASE_URL: 'postgres://test', GEMINI_AGENT_KEYS: value });
  const problem = (value: string) => {
    try {
      env(value);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected parseEnv to refuse the value');
  };

  it('is optional: absent, empty or {} means no sandbox accounts', () => {
    expect(env().GEMINI_AGENT_KEYS).toEqual({});
    expect(env('').GEMINI_AGENT_KEYS).toEqual({});
    expect(env('{}').GEMINI_AGENT_KEYS).toEqual({});
  });

  it('maps arena agent keys to their sandbox keys, and several may share one', () => {
    const value = JSON.stringify({ 'arena-gpt': KEYS, 'arena-claude': KEYS });
    expect(env(value).GEMINI_AGENT_KEYS).toEqual({ 'arena-gpt': KEYS, 'arena-claude': KEYS });
  });

  it('maps every arena model to one key pair given as GEMINI_AGENT_API_KEY and GEMINI_AGENT_API_SECRET', () => {
    const pair = { GEMINI_AGENT_API_KEY: KEYS.apiKey, GEMINI_AGENT_API_SECRET: KEYS.apiSecret };
    expect(parseEnv({ DATABASE_URL: 'postgres://test', ...pair }).GEMINI_AGENT_KEYS).toEqual({
      'arena-gemini': KEYS,
      'arena-claude': KEYS,
      'arena-gpt': KEYS,
      'arena-grok': KEYS,
      'arena-deepseek': KEYS,
    });
    // GEMINI_AGENT_KEYS wins when both forms are set.
    const one = { 'arena-gpt': { apiKey: 'account-other', apiSecret: 'other-secret' } };
    expect(
      parseEnv({ DATABASE_URL: 'postgres://test', ...pair, GEMINI_AGENT_KEYS: JSON.stringify(one) }).GEMINI_AGENT_KEYS,
    ).toEqual(one);
    // Empty means not set.
    expect(parseEnv({ DATABASE_URL: 'postgres://test', GEMINI_AGENT_API_KEY: '', GEMINI_AGENT_API_SECRET: '' }).GEMINI_AGENT_KEYS).toEqual({});
  });

  it('refuses half a key pair, naming both variables but neither value', () => {
    for (const half of [{ GEMINI_AGENT_API_KEY: 'account-leak' }, { GEMINI_AGENT_API_SECRET: 'secret-leak' }]) {
      let message = '';
      try {
        parseEnv({ DATABASE_URL: 'postgres://test', ...half });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('GEMINI_AGENT_API_KEY');
      expect(message).toContain('GEMINI_AGENT_API_SECRET');
      expect(message).not.toContain('leak');
    }
  });

  it('refuses a malformed or wrongly shaped value, naming the variable but never its value', () => {
    const cases = [
      '{"arena-gpt": {"apiKey": "account-leak", "apiSecret": "secret-leak"',
      '["account-leak", "secret-leak"]',
      JSON.stringify({ 'arena-gpt': { apiKey: 'account-leak' } }),
      JSON.stringify({ 'arena-gpt': { apiKey: 'account-leak', apiSecret: '' } }),
      JSON.stringify({ 'arena-gtp': { apiKey: 'account-leak', apiSecret: 'secret-leak' } }),
      JSON.stringify({ 'account-leak': { apiKey: 'account-leak', apiSecret: 'secret-leak' } }),
      JSON.stringify({ 'arena-gpt': KEYS, 'arena-claude': { apiKey: KEYS.apiKey, apiSecret: 'secret-leak' } }),
    ];
    for (const value of cases) {
      const message = problem(value);
      expect(message).toContain('GEMINI_AGENT_KEYS');
      expect(message).not.toMatch(/leak|test-secret|account-test-key/);
    }
  });
});
