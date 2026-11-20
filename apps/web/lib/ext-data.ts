import 'server-only';
import { getExtensionCard, listExtensionMarkets } from '@thesis/db';
import { getDb } from './db';
import { dbError, NOT_CONFIGURED, SYMBOL, type Loaded } from './market-data';
import { toExtCard, toExtMarkets, type ExtCard, type ExtMarketsResponse } from './ext-view';

/** Loads what the Chrome extension's API routes send. */

/**
 * The extension's service worker fetches with host permissions, which needs no CORS, but
 * the plan asks for it so the routes also work from any other read-only client. The data
 * is public and no cookie is read, so any origin may read it.
 */
export const EXT_CORS_HEADERS = { 'access-control-allow-origin': '*' };

export async function loadExtMarkets(): Promise<Loaded<ExtMarketsResponse>> {
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const now = new Date();
    return { ok: true, data: toExtMarkets(await listExtensionMarkets(db, now), now) };
  } catch (error) {
    return dbError(error);
  }
}

export async function loadExtCard(symbol: string | null): Promise<Loaded<ExtCard>> {
  if (symbol === null || !SYMBOL.test(symbol)) {
    return {
      ok: false,
      status: 400,
      error: { code: 'bad_symbol', message: 'Pass a market symbol: ?symbol=GEMI-...' },
    };
  }
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  try {
    const data = await getExtensionCard(db, symbol);
    if (!data) {
      return { ok: false, status: 404, error: { code: 'not_found', message: 'No tracked market has this symbol.' } };
    }
    return { ok: true, data: toExtCard(data) };
  } catch (error) {
    return dbError(error);
  }
}
