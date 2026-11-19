import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const UserId = z.string().uuid();
export const SESSION_SECONDS = 7 * 24 * 3600;
function sign(payload: string, secret: string) {
  if (secret.length < 32) throw new Error('session_not_configured');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
export function sessionToken(userId: string, secret: string, now = Date.now()) {
  UserId.parse(userId);
  const payload = `${userId}.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  return `${payload}.${sign(payload, secret)}`;
}
export function sessionUser(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token || token.length > 180 || secret.length < 32) return null;
  const [id, expiry, signature, extra] = token.split('.');
  if (extra || !id || !expiry || !signature || !UserId.safeParse(id).success || !/^\d+$/.test(expiry)) return null;
  const seconds = Number(expiry);
  if (seconds <= now / 1000 || seconds > now / 1000 + SESSION_SECONDS + 60) return null;
  const expected = Buffer.from(sign(`${id}.${expiry}`, secret));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? id : null;
}
