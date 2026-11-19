import { NextResponse } from 'next/server';
import { copyTrade } from '@/lib/copy-trade';
import { getDb } from '@/lib/db';
import { allowWrite } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/**
 * Copies a thesis's trade for the signed-in guest: the same side, at the current price,
 * within their limits. Body: `{ amountUsd, tipUsdc, idempotencyKey }`. Repeating a request
 * with the same key returns the first result. `409 price_moved` carries the new `price`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  if (!db) return error(503, 'not_configured', 'No database is connected.');
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'Start a session first.');
  if (!allowWrite(`user:${user.id}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');

  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const result = await copyTrade(db, user, id, body, {
      now: new Date(),
      tradingEnabled: process.env.TRADING_ENABLED !== 'false',
      // Tips need the escrow contract. The worker sends them; this app only records them.
      tipsEnabled: Boolean(process.env.ESCROW_ADDRESS),
    });
    if (!result.ok) return NextResponse.json(result.error, { status: result.status });
    return NextResponse.json(result.data);
  } catch (cause) {
    console.error('copy trade failed', cause);
    return error(503, 'db_error', 'The trade could not be placed. Nothing was charged; try again in a moment.');
  }
}
