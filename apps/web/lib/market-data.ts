import 'server-only';
import { getMarketDetail, listOpenMarkets } from '@thesis/db';
import { cache } from 'react';
import { getDb } from './db';
import { chartStart, toMarketDetailView, toMarketView } from './market-mapping';
import type { ApiError, MarketDetailResponse, MarketsResponse } from './market-view';

/** Loads what the Markets pages and their API routes send. Pages and routes share it. */

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

const NOT_CONFIGURED: Loaded<never> = {
  ok: false,
  status: 503,
  error: { code: 'not_configured', message: 'No database is connected.' },
};

function dbError(error: unknown): Loaded<never> {
  // The message can name the database host or user. Keep it in the server log.
  console.error('market query failed', error);
  return {
    ok: false,
    status: 503,
    error: { code: 'db_error', message: 'Market data could not be read. Try again in a moment.' },
  };
}

/** Symbols are letters, digits, dots, dashes and underscores. Anything else is not a symbol. */
const SYMBOL = /^[A-Za-z0-9._-]{1,100}$/;

export async function loadMarkets(): Promise<Loaded<MarketsResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const now = new Date();
    const rows = await listOpenMarkets(db, now);
    return { ok: true, data: { asOf: now.toISOString(), markets: rows.map(toMarketView) } };
  } catch (error) {
    return dbError(error);
  }
}

/** Cached for the length of one request, so a page and its metadata share one read. */
export const loadMarketDetail = cache(
  async (symbol: string): Promise<Loaded<MarketDetailResponse>> => {
    const notFound: Loaded<never> = {
      ok: false,
      status: 404,
      error: { code: 'not_found', message: 'No tracked market has this symbol.' },
    };
    if (!SYMBOL.test(symbol)) return notFound;
    const db = getDb();
    if (!db) return NOT_CONFIGURED;
    try {
      const now = new Date();
      const detail = await getMarketDetail(db, symbol, {
        pointsFrom: (market) => chartStart(market, now),
      });
      if (!detail) return notFound;
      return { ok: true, data: toMarketDetailView(detail, now) };
    } catch (error) {
      return dbError(error);
    }
  },
);
