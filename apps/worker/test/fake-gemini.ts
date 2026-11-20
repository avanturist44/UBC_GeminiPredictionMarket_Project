import type { SandboxAccountOptions } from '../src/sandbox-account';

/** Gemini's REST API as the sandbox SDK client sees it, for tests. Nothing here makes a real call. */

/** The SDK's fetch, answered here instead of by the network. */
type FetchLike = NonNullable<SandboxAccountOptions['fetch']>;

export interface Sent {
  url: string;
  method: string;
  /** The signed envelope, decoded; null for an unsigned request. */
  payload: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  /** When the request arrived, in epoch milliseconds. */
  at: number;
}
export type Reply = { status: number; body: string } | Error;

export const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) });
export const refusal = (status: number, reason: string): Reply => json(status, { result: 'error', reason, message: reason });

/** Answers from `routes` ("METHOD /path"), keeping every request and how many were in flight at once. */
export function fakeGemini(routes: Record<string, (sent: Sent) => Reply>) {
  const sent: Sent[] = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  const fetch: FetchLike = async (url, init) => {
    inFlight += 1;
    mostAtOnce = Math.max(mostAtOnce, inFlight);
    try {
      const envelope = init.headers['X-GEMINI-PAYLOAD'];
      const request: Sent = {
        url,
        method: init.method,
        payload: envelope ? (JSON.parse(Buffer.from(envelope, 'base64').toString('utf8')) as Record<string, unknown>) : null,
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        at: Date.now(),
      };
      await new Promise((resolve) => setTimeout(resolve, 2));
      sent.push(request);
      const route = routes[`${init.method} ${new URL(url).pathname}`];
      const reply = route ? route(request) : refusal(404, 'NotFound');
      if (reply instanceof Error) throw reply;
      return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, sent, mostAtOnce: () => mostAtOnce };
}

/** An event with two contracts, one of them `symbol` with a YES ask of 0.55 and a NO ask of 0.47. */
export function eventWith(symbol: string): Reply {
  const ticker = /^GEMI-(.+)-[^-]+$/.exec(symbol)![1];
  return json(200, {
    ticker,
    contracts: [
      { instrumentSymbol: `GEMI-${ticker}-OTHER`, prices: { buy: { yes: '0.10', no: '0.90' } } },
      { instrumentSymbol: symbol, prices: { buy: { yes: '0.55', no: '0.47' }, bestBid: '0.53', bestAsk: '0.55' } },
    ],
  });
}

/** The sandbox's reply to an order: filled in full at its price, echoing the client order id. */
export const filled = (sent: Sent): Reply => ({
  status: 201,
  // Order ids are 64-bit; the SDK reads them without rounding.
  body:
    `{"orderId":145853902320985497,"clientOrderId":${JSON.stringify(sent.body?.clientOrderId)},"status":"filled",` +
    `"filledQuantity":${JSON.stringify(sent.body?.quantity)},"avgExecutionPrice":${JSON.stringify(sent.body?.price)}}`,
});
