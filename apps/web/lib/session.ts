import 'server-only';
import { applyDueLimits, getUserById, type UserRow } from '@thesis/db';
import { cookies } from 'next/headers';
import { getDb } from './db';
import { signSession, verifySession } from './session-token';

export const SESSION_COOKIE = 'tm_session';

/**
 * Null in production when SESSION_SECRET is missing: sessions are then refused instead of
 * signed with a guessable key. Local development falls back to a fixed key.
 */
function secret(): string | null {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? null : 'local-development-only-session-secret';
}

export const sessionsConfigured = () => secret() !== null;

/** The signed-in guest, or null. A limit raise that has come due is applied on the way. */
export async function getSessionUser(): Promise<UserRow | null> {
  const key = secret();
  const db = getDb();
  if (!key || !db) return null;
  const userId = verifySession((await cookies()).get(SESSION_COOKIE)?.value, key);
  const user = userId ? await getUserById(db, userId) : null;
  return user ? applyDueLimits(db, user, new Date()) : null;
}

export async function startSession(user: Pick<UserRow, 'id'>): Promise<void> {
  const key = secret();
  if (!key) throw new Error('SESSION_SECRET is not set');
  (await cookies()).set(SESSION_COOKIE, signSession(user.id, key), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}
