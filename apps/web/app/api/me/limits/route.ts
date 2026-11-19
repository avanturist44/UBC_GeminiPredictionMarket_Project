import { NextResponse } from 'next/server';
import { allowWrite } from '@/lib/rate-limit';
import { changeLimits } from '@/lib/record-data';
import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/**
 * Changes the signed-in guest's limits. Body: `{ maxPerTradeUsd?, dailyCopyCapUsd? }` in
 * dollars. Lowering a limit applies at once; raising one applies from the next UTC day.
 */
export async function PATCH(request: Request) {
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'Start a session first.');
  if (!allowWrite(`user:${user.id}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  return respond(await changeLimits(user, await request.json().catch(() => null), new Date()));
}
