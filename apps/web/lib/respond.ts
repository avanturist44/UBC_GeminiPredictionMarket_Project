import 'server-only';
import { NextResponse } from 'next/server';
import type { Loaded } from './market-data';

/**
 * Sends a loader's result: the data, or `{ code, message }` with its status. Never cached.
 * `extraHeaders` are added to either, for example CORS headers.
 */
export function respond<T>(loaded: Loaded<T>, extraHeaders: Record<string, string> = {}): NextResponse {
  const headers = { 'cache-control': 'no-store', ...extraHeaders };
  if (loaded.ok) return NextResponse.json(loaded.data, { headers });
  return NextResponse.json(loaded.error, { status: loaded.status, headers });
}
