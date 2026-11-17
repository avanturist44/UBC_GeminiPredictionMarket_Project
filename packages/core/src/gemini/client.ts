import type { z } from 'zod';
import {
  CategoriesSchema,
  EventListSchema,
  EventSchema,
  StrikeSchema,
  findUnknownKeys,
  type GeminiEvent,
  type GeminiEventList,
  type GeminiStrike,
} from './schemas';

/**
 * Thin client for Gemini's public Prediction Markets endpoints. No key is needed.
 * One request every 2 seconds, a 10 second timeout, one retry on 429 or 5xx.
 * Only endpoints and parameters listed in the build plan are exposed.
 */

export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Gemini ${path} returned HTTP ${status}: ${body}`);
    this.name = 'GeminiHttpError';
  }
}

export class GeminiParseError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`Gemini ${path} did not match the expected shape: ${issues}`);
    this.name = 'GeminiParseError';
  }
}

export interface GeminiPublicClientOptions {
  /** Defaults to the production host, which serves real markets without a key. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Minimum gap between requests. Gemini allows 120 a minute and asks for under one a second. */
  minIntervalMs?: number;
  timeoutMs?: number;
  logger?: { warn: (message: string) => void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ListEventsParams {
  status?: 'approved' | 'active' | 'closed' | 'under_review' | 'settled' | 'invalid';
  category?: string;
  /** Matches event tickers and titles. */
  search?: string;
  /** 1 to 500, default 50. */
  limit?: number;
  offset?: number;
}

export interface GeminiPublicClient {
  listEvents(params?: ListEventsParams): Promise<GeminiEventList>;
  /** Null when Gemini has no event with this ticker. */
  getEvent(eventTicker: string): Promise<GeminiEvent | null>;
  /** Null when Gemini has no event with this ticker. */
  getStrike(eventTicker: string): Promise<GeminiStrike | null>;
  listRecentlySettled(): Promise<GeminiEventList>;
  getCategories(): Promise<string[]>;
}

const BASE_PATH = '/v1/prediction-markets';

export function createGeminiPublicClient(options: GeminiPublicClientOptions = {}): GeminiPublicClient {
  const baseUrl = (options.baseUrl ?? 'https://api.gemini.com').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const minIntervalMs = options.minIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Each caller reserves the next free slot before waiting, so concurrent calls queue up.
  let nextSlotAt = 0;
  async function waitForSlot(): Promise<void> {
    const current = now();
    const slot = Math.max(current, nextSlotAt);
    nextSlotAt = slot + minIntervalMs;
    if (slot > current) await sleep(slot - current);
  }

  async function request(path: string): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      await waitForSlot();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { status: response.status, json: await response.json() };
      if (response.status === 404) return { status: 404, json: null };
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) continue;
      const body = await response.text().catch(() => '');
      throw new GeminiHttpError(response.status, path, body.slice(0, 300));
    }
  }

  function parse<S extends z.ZodType>(schema: S, path: string, json: unknown): z.infer<S> {
    const result = schema.safeParse(json);
    if (result.success) return result.data;
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new GeminiParseError(path, issues);
  }

  const reported = new Set<string>();
  function reportUnknown(events: GeminiEvent[]): void {
    const fresh = events.flatMap(findUnknownKeys).filter((key) => !reported.has(key));
    if (fresh.length === 0) return;
    const unique = [...new Set(fresh)];
    for (const key of unique) reported.add(key);
    logger.warn(`Gemini returned fields this app does not know: ${unique.join(', ')}`);
  }

  async function getList(path: string): Promise<GeminiEventList> {
    const { status, json } = await request(path);
    if (status === 404) throw new GeminiHttpError(404, path, '');
    const list = parse(EventListSchema, path, json);
    reportUnknown(list.data);
    return list;
  }

  return {
    async listEvents(params = {}) {
      const query = new URLSearchParams();
      for (const key of ['status', 'category', 'search', 'limit', 'offset'] as const) {
        const value = params[key];
        if (value !== undefined) query.set(key, String(value));
      }
      const suffix = query.size > 0 ? `?${query}` : '';
      return getList(`${BASE_PATH}/events${suffix}`);
    },

    async getEvent(eventTicker) {
      const path = `${BASE_PATH}/events/${encodeURIComponent(eventTicker)}`;
      const { status, json } = await request(path);
      if (status === 404) return null;
      const event = parse(EventSchema, path, json);
      reportUnknown([event]);
      return event;
    },

    async getStrike(eventTicker) {
      const path = `${BASE_PATH}/events/${encodeURIComponent(eventTicker)}/strike`;
      const { status, json } = await request(path);
      if (status === 404) return null;
      return parse(StrikeSchema, path, json);
    },

    listRecentlySettled() {
      return getList(`${BASE_PATH}/events/recently-settled`);
    },

    async getCategories() {
      const path = `${BASE_PATH}/categories`;
      const { status, json } = await request(path);
      if (status === 404) throw new GeminiHttpError(404, path, '');
      return parse(CategoriesSchema, path, json).categories;
    },
  };
}
