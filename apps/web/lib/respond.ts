import 'server-only';
import { NextResponse } from 'next/server';
import type { Loaded } from './market-data';

/** Sends a loader's result: the data, or `{ code, message }` with its status. Never cached. */
export function respond<T>(loaded: Loaded<T>): NextResponse {
  const headers = { 'cache-control': 'no-store' };
  if (loaded.ok) return NextResponse.json(loaded.data, { headers });
  return NextResponse.json(loaded.error, { status: loaded.status, headers });
}
