import { z } from 'zod';
import { isDecimalString } from './schemas';

/**
 * Messages on Gemini's public Prediction Markets WebSocket (wss://ws.gemini.com, no key).
 *
 * Checked against the live socket on 2026-11-18 (see docs/gemini-findings.md):
 * - Requests are `{ id, method, params }` with method SUBSCRIBE or UNSUBSCRIBE. The reply
 *   is `{ id, status: 200 }`, or `{ id, status: 400, error: { code, msg } }`.
 * - A `{symbol}@bookTicker` subscription sends the current book at once, then every change.
 * - bookTicker is `{ u, E, s, b, B, a, A, c?, C? }`: `s` is the symbol in lower case, `b`/`a`
 *   the best bid and ask, `B`/`A` their sizes, `c` the last trade price. An empty string
 *   means that side of the book is empty.
 */

export interface BookTicker {
  /** The symbol in lower case, as Gemini sends it. Match it with streamSymbolKey. */
  symbolKey: string;
  bid: string | null;
  bidSize: string | null;
  ask: string | null;
  askSize: string | null;
  /** Last trade price. Null when the contract has not traded. */
  last: string | null;
}

export type StreamMessage =
  | { kind: 'bookTicker'; ticker: BookTicker }
  | { kind: 'reply'; id: string; ok: boolean; error?: string }
  | { kind: 'other' };

const BookTickerMessage = z.looseObject({
  s: z.string().min(1),
  b: z.string(),
  B: z.string().optional(),
  a: z.string(),
  A: z.string().optional(),
  c: z.string().optional(),
});

const ReplyMessage = z.looseObject({
  id: z.union([z.string(), z.number()]),
  status: z.number(),
  error: z.looseObject({ msg: z.string().optional() }).optional(),
});

const OTHER: StreamMessage = { kind: 'other' };

/** Undefined when the value is neither empty nor a decimal: the message cannot be trusted. */
function decimalOrNull(value: string | undefined): string | null | undefined {
  if (value === undefined || value === '') return null;
  return isDecimalString(value) ? value : undefined;
}

/** Never throws: anything this app does not use, or cannot read, is `other`. */
export function parseStreamMessage(text: string): StreamMessage {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return OTHER;
  }

  const reply = ReplyMessage.safeParse(json);
  if (reply.success) {
    const ok = reply.data.status === 200;
    const id = String(reply.data.id);
    if (ok) return { kind: 'reply', id, ok };
    return { kind: 'reply', id, ok, error: reply.data.error?.msg ?? `status ${reply.data.status}` };
  }

  const book = BookTickerMessage.safeParse(json);
  if (!book.success) return OTHER;
  const bid = decimalOrNull(book.data.b);
  const ask = decimalOrNull(book.data.a);
  const bidSize = decimalOrNull(book.data.B);
  const askSize = decimalOrNull(book.data.A);
  const last = decimalOrNull(book.data.c);
  if (
    bid === undefined ||
    ask === undefined ||
    bidSize === undefined ||
    askSize === undefined ||
    last === undefined
  ) {
    return OTHER;
  }
  return {
    kind: 'bookTicker',
    ticker: { symbolKey: book.data.s.toLowerCase(), bid, bidSize, ask, askSize, last },
  };
}

/** The stream that carries a contract's best bid and ask. `symbol` is used exactly as returned. */
export function bookTickerStream(instrumentSymbol: string): string {
  return `${instrumentSymbol}@bookTicker`;
}

/** The form of a symbol that bookTicker messages carry. */
export function streamSymbolKey(instrumentSymbol: string): string {
  return instrumentSymbol.toLowerCase();
}
