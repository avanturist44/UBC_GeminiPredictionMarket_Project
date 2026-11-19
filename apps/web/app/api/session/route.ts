import { createGuestUser } from '@thesis/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { allowWrite } from '@/lib/rate-limit';
import { getSessionUser, sessionsConfigured, startSession } from '@/lib/session';
import { toMe } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

const Body = z.object({ displayName: z.string().trim().min(1).max(40).optional() });
const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/**
 * Starts a guest session: a new user with $1,000 of test money, and a signed cookie.
 * Calling it again with a session returns the same user. Wallet creation is Phase 4.
 */
export async function POST(request: Request) {
  const db = getDb();
  if (!db || !sessionsConfigured()) return error(503, 'not_configured', 'Sessions are not set up on this server.');
  const existing = await getSessionUser();
  if (existing) return NextResponse.json(await toMe(existing));

  // No session yet, so the limit is per client address.
  const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!allowWrite(`session:${client}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return error(400, 'invalid', 'A display name is 1 to 40 characters.');
  const displayName = parsed.data.displayName ?? `Guest ${1000 + Math.floor(Math.random() * 9000)}`;
  try {
    const user = await createGuestUser(db, displayName);
    await startSession(user);
    return NextResponse.json(await toMe(user), { status: 201 });
  } catch (cause) {
    console.error('session creation failed', cause);
    return error(503, 'db_error', 'The session could not be created. Try again in a moment.');
  }
}
