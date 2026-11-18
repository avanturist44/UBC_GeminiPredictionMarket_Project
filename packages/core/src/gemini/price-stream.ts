import { bookTickerStream, parseStreamMessage, type BookTicker } from './stream';

/**
 * One WebSocket to Gemini's public stream with a bookTicker subscription per symbol.
 * The worker uses it to record prices, and the web pages use it to show them live.
 *
 * It keeps itself connected. A dropped socket is reopened after 1, 2, 4 ... 30 seconds, and
 * a socket that goes silent (no message and no pong for 45 seconds) is dropped and reopened,
 * because a dead connection is not always closed. Nothing here needs to be retried by the
 * caller: the worker's 30-second REST poll, and the pages' own API, carry on while it is down.
 *
 * It has no socket of its own: the caller passes `connect`, which is the `ws` package in the
 * worker and the browser's WebSocket in a page.
 */

export interface StreamLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** The socket this module needs. It is shaped like the `ws` package's socket. */
export interface StreamSocket {
  on(event: 'open' | 'close' | 'pong', listener: () => void): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  ping(): void;
  /** Drops the connection at once. A `close` event follows. */
  terminate(): void;
}

export interface PriceStreamOptions {
  url: string;
  onTicker: (ticker: BookTicker) => void;
  logger: StreamLogger;
  connect: (url: string) => StreamSocket;
  /** Streams to subscribe to besides the bookTicker of each symbol, such as an index price. */
  extraStreams?: readonly string[];
  /** Receives the text of every message that is not a bookTicker or a reply. */
  onOther?: (message: string) => void;
  pingIntervalMs?: number;
  silenceTimeoutMs?: number;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  /** How long a stream Gemini refused is left alone before it is asked for again. */
  refusedRetryMs?: number;
}

export interface PriceStreamStatus {
  connected: boolean;
  /** Streams Gemini is sending on the current connection. */
  subscribed: number;
  /** Times the connection was re-established after dropping. */
  reconnects: number;
}

export interface PriceStream {
  start(): void;
  /** The instrument symbols to stream. Call again whenever the tracked set changes. */
  setSymbols(symbols: readonly string[]): void;
  status(): PriceStreamStatus;
  stop(): void;
}

interface PendingRequest {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  streams: string[];
}

export function createPriceStream(options: PriceStreamOptions): PriceStream {
  const { url, onTicker, logger, connect } = options;
  const pingIntervalMs = options.pingIntervalMs ?? 15_000;
  const silenceTimeoutMs = options.silenceTimeoutMs ?? 45_000;
  const minReconnectMs = options.minReconnectMs ?? 1000;
  const maxReconnectMs = options.maxReconnectMs ?? 30_000;
  const refusedRetryMs = options.refusedRetryMs ?? 60_000;

  let desired = new Set<string>();
  /** Streams requested on the current connection, whether or not Gemini has replied yet. */
  let subscribed = new Set<string>();
  /**
   * Streams Gemini refused on the current connection, and when. A refused stream is left
   * alone for a minute, then asked for again: Gemini may not have listed it yet.
   */
  let refused = new Map<string, number>();
  let pending = new Map<string, PendingRequest>();

  let socket: StreamSocket | null = null;
  let connected = false;
  let stopped = false;
  let started = false;
  let opens = 0;
  let failedAttempts = 0;
  let requestId = 0;
  let lastActivityAt = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function request(method: PendingRequest['method'], streams: string[]): void {
    if (!socket || streams.length === 0) return;
    requestId += 1;
    const id = String(requestId);
    pending.set(id, { method, streams });
    socket.send(JSON.stringify({ id, method, params: streams }));
  }

  /** Brings the connection's subscriptions in line with the desired symbols. */
  function sync(): void {
    if (!connected) return;
    const time = Date.now();
    for (const [stream, refusedAt] of [...refused]) {
      if (!desired.has(stream) || time - refusedAt >= refusedRetryMs) refused.delete(stream);
    }
    const add = [...desired].filter((s) => !subscribed.has(s) && !refused.has(s));
    const remove = [...subscribed].filter((s) => !desired.has(s));
    for (const stream of add) subscribed.add(stream);
    for (const stream of remove) subscribed.delete(stream);
    request('SUBSCRIBE', add);
    request('UNSUBSCRIBE', remove);
  }

  function onReply(id: string, ok: boolean, error: string | undefined): void {
    const sent = pending.get(id);
    if (!sent) return;
    pending.delete(id);
    if (ok || sent.method === 'UNSUBSCRIBE') return;
    // Gemini refuses a whole request when one stream name in it is bad.
    for (const stream of sent.streams) subscribed.delete(stream);
    if (sent.streams.length > 1) {
      for (const stream of sent.streams) {
        if (!desired.has(stream)) continue;
        subscribed.add(stream);
        request('SUBSCRIBE', [stream]);
      }
      return;
    }
    const [stream] = sent.streams;
    if (stream) refused.set(stream, Date.now());
    logger.warn(`stream: Gemini refused ${stream}: ${error ?? 'no reason given'}`);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const wait = Math.min(minReconnectMs * 2 ** failedAttempts, maxReconnectMs);
    failedAttempts += 1;
    reconnectTimer = setTimeout(open, wait);
  }

  function open(): void {
    if (stopped) return;
    const current = connect(url);
    socket = current;
    const isCurrent = () => socket === current;

    current.on('open', () => {
      if (!isCurrent()) return;
      connected = true;
      opens += 1;
      lastActivityAt = Date.now();
      logger.info(`stream: connected to ${url}`);
      pingTimer = setInterval(() => {
        if (Date.now() - lastActivityAt >= silenceTimeoutMs) {
          logger.warn(`stream: nothing received for ${silenceTimeoutMs / 1000}s, reconnecting`);
          current.terminate();
          return;
        }
        current.ping();
      }, pingIntervalMs);
      sync();
    });

    const alive = () => {
      lastActivityAt = Date.now();
      // Data is flowing, so the next reconnect starts from the shortest wait again.
      failedAttempts = 0;
    };

    current.on('pong', () => {
      if (isCurrent()) alive();
    });

    current.on('message', (data) => {
      if (!isCurrent()) return;
      alive();
      const text = data.toString();
      const message = parseStreamMessage(text);
      if (message.kind === 'bookTicker') onTicker(message.ticker);
      else if (message.kind === 'reply') onReply(message.id, message.ok, message.error);
      else options.onOther?.(text);
    });

    current.on('error', (error) => {
      if (!isCurrent()) return;
      // A refused connection arrives as an error with an empty message and a code.
      const code = (error as Error & { code?: unknown }).code;
      logger.warn(`stream: socket error: ${error.message || String(code ?? error.name)}`);
    });

    current.on('close', () => {
      if (!isCurrent()) return;
      const wasConnected = connected;
      socket = null;
      connected = false;
      subscribed = new Set();
      refused = new Map();
      pending = new Map();
      clearInterval(pingTimer);
      if (wasConnected && !stopped) logger.warn('stream: disconnected');
      scheduleReconnect();
    });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      open();
    },
    setSymbols(symbols) {
      desired = new Set([...symbols.map(bookTickerStream), ...(options.extraStreams ?? [])]);
      sync();
    },
    status() {
      return { connected, subscribed: subscribed.size, reconnects: Math.max(0, opens - 1) };
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      socket?.terminate();
    },
  };
}
