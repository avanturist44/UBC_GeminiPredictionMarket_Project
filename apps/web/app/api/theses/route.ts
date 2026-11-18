import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { allowWrite } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';
import { submitThesis } from '@/lib/thesis-submit';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/**
 * Submits a person's thesis. It is checked here and stored for the auditor; the worker
 * audits it, places the author's trade and publishes it, or blocks it. The reply is 202:
 * poll `GET /api/theses/[id]` for what became of it.
 */
export async function POST(request: Request) {
  const db = getDb();
  if (!db) return error(503, 'not_configured', 'No database is connected.');
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'Start a session first.');
  if (!allowWrite(`user:${user.id}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');

  const body: unknown = await request.json().catch(() => null);
  try {
    const result = await submitThesis(db, user, body, {
      now: new Date(),
      tradingEnabled: process.env.TRADING_ENABLED !== 'false',
    });
    if (!result.ok) return NextResponse.json(result.error, { status: result.status });
    return NextResponse.json(result.data, { status: 202 });
  } catch (cause) {
    console.error('thesis submission failed', cause);
    return error(503, 'db_error', 'The thesis could not be saved. Try again in a moment.');
  }
}
