import {
  createPriceStream as createStream,
  type PriceStream,
  type PriceStreamOptions,
  type StreamSocket,
} from '@thesis/core';
import WebSocket from 'ws';

/**
 * Worker job 1, live part: the shared price stream (packages/core) over the `ws` package.
 * See price-stream.ts for how it stays connected.
 */

export type { PriceStream, PriceStreamStatus, StreamSocket } from '@thesis/core';

export type WorkerStreamOptions = Omit<PriceStreamOptions, 'connect'> & {
  /** Tests supply a stand-in. */
  connect?: (url: string) => StreamSocket;
};

export function createPriceStream(options: WorkerStreamOptions): PriceStream {
  return createStream({
    ...options,
    // Without a handshake timeout a connection that never finishes opening would emit
    // nothing, and the reconnect logic would wait on it for ever.
    connect:
      options.connect ??
      ((target: string): StreamSocket => new WebSocket(target, { handshakeTimeout: 10_000 })),
  });
}
