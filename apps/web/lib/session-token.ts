import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The session cookie's value: the user id and an HMAC of it under SESSION_SECRET. The
 * cookie proves which guest account a browser holds; it carries nothing else.
 */

const sign = (userId: string, secret: string) => createHmac('sha256', secret).update(userId).digest('base64url');

export function signSession(userId: string, secret: string): string {
  return `${userId}.${sign(userId, secret)}`;
}

/** The user id if the value was signed with this secret, otherwise null. */
export function verifySession(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(userId, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}
