/**
 * The arena models' Gemini sandbox accounts, through Gemini's SDK. This is the only file that
 * imports the SDK, and every client it builds is fixed to the sandbox: nothing in this repo can
 * sign a request to the production exchange.
 *
 * What the live sandbox did is in docs/gemini-findings.md: keys are account-level (they start
 * with `account-`) and created with "Uses a time based nonce", and for outcome "no" an order's
 * price is the NO price.
 */
import {
  ApiError,
  HmacAuth,
  InvalidNonce,
  NotFoundError,
  ValidationError,
  createClient,
  type FetchLike,
} from '@gemini-markets/sdk/server';
import type { Logger } from './recorder';
import { SandboxRefused, type SandboxAccount, type SandboxFill } from './sandbox-mirror';

export interface SandboxKeys {
  apiKey: string;
  apiSecret: string;
}

/** What verify:arena and the worker's start-up check read. Nothing here changes the account. */
export interface SandboxAccountCheck {
  /** Whether the account has accepted Gemini's latest prediction market terms. */
  termsAccepted: boolean;
  /** Test USD available to trade, or null when it could not be read. */
  availableUsd: string | null;
  /** Why the balance could not be read. */
  balanceError: string | null;
}

export interface GeminiSandboxAccount extends SandboxAccount {
  /** Read only. Terms are accepted by a person on exchange.sandbox.gemini.com, never in code. */
  check(): Promise<SandboxAccountCheck>;
}

export interface SandboxAccountOptions {
  /** Answers the SDK's requests instead of the network, for tests. */
  fetch?: FetchLike;
  /** For a warning the mirror cannot see: the sandbox not keeping an order's client order id. */
  logger?: Logger;
}

/**
 * The clock behind one key's nonces. A time-based nonce is the epoch second, and Gemini's
 * documentation does not say whether two signed requests may share one, so each gets a second of
 * its own. Gemini also refuses a nonce more than 30 seconds from its own clock, so the nonces
 * must not run ahead of real time: before each signed call `free()` waits until the last second
 * used has passed. `now` is the SDK's clock; it moves one second on only when the SDK signs twice
 * within one call (a retried read), and the next `free()` waits that lead out.
 */
function nonceClock(): { now: () => number; free: () => Promise<void> } {
  let lastSecond = 0;
  return {
    now: () => {
      lastSecond = Math.max(Math.floor(Date.now() / 1000), lastSecond + 1);
      return lastSecond * 1000;
    },
    free: async () => {
      const wait = (lastSecond + 1) * 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    },
  };
}

/** Runs calls one after another, in the order they were made. */
function oneAtATime(): <T>(call: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (call) => {
    const result = tail.then(call);
    tail = result.catch(() => {});
    return result;
  };
}

/**
 * A refusal the sandbox would repeat (a 4xx other than a timeout, a rate limit or a rejected nonce,
 * or an order the SDK rejects before sending) becomes SandboxRefused. Anything else may clear up,
 * and is passed on as it is. A request whose nonce was rejected was never looked at, so it is safe
 * to send again, and likely to succeed with a fresh nonce.
 */
function refusalOf(error: unknown): unknown {
  if (error instanceof ValidationError) return new SandboxRefused('invalid_input');
  if (error instanceof InvalidNonce) return error;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    // The SDK's stable code, or the exchange's own reason when the SDK has no code for it.
    const code = error.code !== 'unknown' ? error.code : (error.reason ?? `http_${error.status}`);
    return new SandboxRefused(code.slice(0, 64));
  }
  return error;
}

/** Gemini's symbols are GEMI-<event ticker>-<contract>; the ask is read from the event. */
function eventTickerOf(symbol: string): string | null {
  return /^GEMI-(.+)-[^-]+$/.exec(symbol)?.[1] ?? null;
}

function fillOf(order: { orderId?: bigint; filledQuantity?: string; avgExecutionPrice?: string | null }): SandboxFill {
  return {
    orderId: order.orderId === undefined ? '' : order.orderId.toString(),
    filledQuantity: order.filledQuantity ?? '0',
    avgPrice: order.avgExecutionPrice ?? null,
  };
}

/** One sandbox account. Its calls go one at a time, and each signed request has its own nonce. */
export async function createSandboxAccount(
  keys: SandboxKeys,
  options: SandboxAccountOptions = {},
): Promise<GeminiSandboxAccount> {
  const nonces = nonceClock();
  const gemini = await createClient({
    // Fixed on purpose. There is no production order path in this repo.
    env: 'sandbox',
    auth: new HmacAuth({ apiKey: keys.apiKey, apiSecret: keys.apiSecret, nonceMode: 'time-based', now: nonces.now }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  // Every call waits its turn; a signed one also waits for a second its nonce can have alone.
  const serial = oneAtATime();
  const signed = async <T>(call: () => Promise<T>): Promise<T> => {
    await nonces.free();
    return call();
  };

  return {
    ask: (symbol, side) =>
      serial(async () => {
        const eventTicker = eventTickerOf(symbol);
        if (!eventTicker) return null;
        let event;
        try {
          event = await gemini.predictions.getEvent({ eventTicker });
        } catch (error) {
          // The sandbox does not list every production event.
          if (error instanceof NotFoundError) return null;
          throw refusalOf(error);
        }
        const price = event.contracts?.find((c) => c.instrumentSymbol === symbol)?.prices?.buy?.[side];
        return price && Number(price) > 0 ? price : null;
      }),

    place: (o) =>
      serial(async () => {
        // The SDK's type for this request has no client order id, but the order responses carry
        // one and the SDK sends the field on. Without it a retry could not tell whether an order
        // arrived, so it is sent, and a reply that does not echo it is warned about below.
        const order = {
          symbol: o.symbol,
          orderType: 'limit',
          side: 'buy',
          outcome: o.side,
          quantity: o.quantity,
          // For outcome "no" this is the NO price, as quoted.
          price: o.price,
          timeInForce: 'immediate-or-cancel',
          makerOrCancel: false,
          clientOrderId: o.clientOrderId,
        } as const;
        let reply;
        try {
          reply = await signed(() => gemini.predictions.placeOrder(order));
        } catch (error) {
          throw refusalOf(error);
        }
        if (reply.clientOrderId !== o.clientOrderId) {
          options.logger?.warn(
            `the sandbox did not keep client order id ${o.clientOrderId} on order ${String(reply.orderId)}: ` +
              'after a network error this trade could not be found, and could be placed twice',
          );
        }
        return fillOf(reply);
      }),

    findByClientOrderId: (id) =>
      serial(async () => {
        let reply;
        try {
          // Newest first is not documented, so ask for the most the endpoint gives: 1,000 orders,
          // over a month of an arena model's trading.
          reply = await signed(() => gemini.predictions.getOrderHistory({ limit: 1000 }));
        } catch (error) {
          throw refusalOf(error);
        }
        const order = reply.orders?.find((o) => o.clientOrderId === id);
        return order ? fillOf(order) : null;
      }),

    check: () =>
      serial(async () => {
        let terms;
        try {
          terms = await signed(() => gemini.predictions.getPredictionMarketsTermsStatus());
        } catch (error) {
          throw refusalOf(error);
        }
        let availableUsd: string | null = null;
        let balanceError: string | null = null;
        try {
          // `account` names a subaccount and is needed only with a master key. These keys are
          // account-level, so the key names the account; the SDK's type marks the field required.
          const balances = await signed(() => gemini.account.getAvailableBalances({} as { account: string }));
          availableUsd = String(balances.find((b) => b.currency === 'USD')?.available ?? 0);
        } catch (error) {
          const refused = refusalOf(error);
          balanceError = refused instanceof SandboxRefused ? refused.code : refused instanceof Error ? refused.message : 'unknown error';
        }
        return { termsAccepted: terms.hasAcceptedLatest === true, availableUsd, balanceError };
      }),
  };
}

/**
 * The accounts for GEMINI_AGENT_KEYS, by agent key. Several models may share one sandbox account
 * (a sandbox login holds one account for now), and one key gets one account, so its nonces come
 * from one clock and its calls go one at a time.
 */
export async function createSandboxAccounts(
  keysByAgent: Record<string, SandboxKeys>,
  options: SandboxAccountOptions = {},
): Promise<Map<string, GeminiSandboxAccount>> {
  const byApiKey = new Map<string, GeminiSandboxAccount>();
  const accounts = new Map<string, GeminiSandboxAccount>();
  for (const [agentKey, keys] of Object.entries(keysByAgent)) {
    let account = byApiKey.get(keys.apiKey);
    if (!account) {
      account = await createSandboxAccount(keys, options);
      byApiKey.set(keys.apiKey, account);
    }
    accounts.set(agentKey, account);
  }
  return accounts;
}

/** Each distinct account once, with the agents that use it, in the order first seen. */
export function accountGroups<A>(accounts: Map<string, A>): { account: A; agentKeys: string[] }[] {
  const groups = new Map<A, string[]>();
  for (const [agentKey, account] of accounts) groups.set(account, [...(groups.get(account) ?? []), agentKey]);
  return [...groups].map(([account, agentKeys]) => ({ account, agentKeys }));
}
