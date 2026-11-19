import type { LlmError, LlmRequest } from '@thesis/core';

/** Stand-ins for the network in the provider adapter tests. Nothing here makes a real call. */

export interface FetchCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with `reply`. */
export function fakeFetch(reply: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return reply(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Answers with each queued response in turn. */
export const queued = (responses: Response[]) => fakeFetch(() => responses.shift() ?? json(599, {}));

/** A fetch that never answers, and gives up only when its request is aborted. */
export const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof globalThis.fetch;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The error a promise rejects with, or null when it resolves. */
export const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as LlmError,
  );

export const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

export const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  system: 'SYSTEM PROMPT',
  user: 'USER MESSAGE',
  useSearch: false,
  jsonSchema: SCHEMA,
  timeoutMs: 5_000,
  ...overrides,
});
