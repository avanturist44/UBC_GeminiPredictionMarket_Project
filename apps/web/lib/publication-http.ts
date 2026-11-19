import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { PublicationError, sessionUser } from '@thesis/services';
import { getDb } from './db';

export const SESSION_COOKIE = 'thesis_session';
export const PUBLICATION_MESSAGES: Record<string, string> = {
  chain_not_configured: 'Arc testnet copying is not configured yet.', testnet_only: 'This application only supports Arc testnet.',
  escrow_mismatch: 'The escrow configuration could not be verified. Copying is paused.',
  thesis_not_copyable: 'This thesis is not registered for copying, or is no longer open.', own_thesis: 'You cannot copy or tip your own thesis.',
  wallet_not_ready: 'Prepare your test wallet before adding a USDC tip.', wallet_unavailable: 'Your test wallet is unavailable.',
  wallet_daily_limit: 'Today’s test-wallet funding allowance has been reached. You can still copy with no tip.',
  insufficient_usdc: 'Your test wallet has insufficient available USDC or allowance for this tip.', tip_limit: 'The five-USDC tip limit for this thesis would be exceeded.',
  quote_expired: 'The quote has expired. Review a fresh quote before confirming.', price_moved: 'The price moved. Review the new quote and confirm again.',
  quote_changed: 'The book changed during confirmation. Review a fresh quote.', quote_unavailable: 'A fresh executable quote is unavailable. Try again shortly.',
  per_trade_limit: 'The amount exceeds your per-trade paper limit.', daily_limit: 'This would exceed your daily paper spending cap.',
  insufficient_balance: 'Your simulated balance is insufficient.', no_fill: 'Available market size or quantity rules prevented a fill.',
  session_required: 'Create a guest session to continue.', session_not_configured: 'Guest sessions are not configured yet.',
  not_configured: 'A database connection is required.', invalid_input: 'Check the thesis fields and source URL.',
  invalid_cursor: 'This feed cursor is invalid.', invalid_origin: 'Submit from this website.',
  rate_limit: 'Too many submissions. Wait a minute and try again.', audit_budget: 'The hourly submission allowance has been reached.',
  market_unavailable: 'This market is unavailable or too close to expiry. Choose another market.',
  position_exists: 'You already have a thesis or position on this contract.', idempotency_conflict: 'This submission key was already used for different content.',
  auditing_disabled: 'Publishing is paused while auditing is unavailable.', trading_disabled: 'New paper trades are paused.',
  unavailable: 'The request could not be completed. Please try again.',
};
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
export function publicationFailure(error: unknown) {
  const code = error instanceof PublicationError ? error.code : error instanceof ZodError ? 'invalid_input' : 'unavailable';
  return json({ code, message: PUBLICATION_MESSAGES[code] ?? PUBLICATION_MESSAGES.unavailable },
    error instanceof PublicationError ? error.status : error instanceof ZodError ? 400 : 503);
}
export function publicationDb() {
  const db = getDb();
  if (!db) throw new PublicationError('not_configured', 503);
  return db;
}
export async function viewerId() {
  const jar = await cookies();
  return sessionUser(jar.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET ?? '');
}
export async function requestJson(request: Request) {
  // Next may use its internal hostname in request.url. The incoming Host identifies the site the browser visited.
  const host = request.headers.get('host');
  const expected = host && /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d+)?$/i.test(host)
    ? new URL(`${new URL(request.url).protocol}//${host}`).origin : null;
  if (!expected || request.headers.get('origin') !== expected ||
    request.headers.get('sec-fetch-site') === 'cross-site') throw new PublicationError('invalid_origin', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PublicationError('invalid_input', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new PublicationError('invalid_input', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) { await reader.cancel(); throw new PublicationError('invalid_input', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError('invalid_input', 400);
  } finally { reader.releaseLock(); }
}
