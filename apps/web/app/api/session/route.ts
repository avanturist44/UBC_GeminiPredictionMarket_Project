import { cookies } from 'next/headers';
import { z } from 'zod';
import { createGuest, PublicationError, sessionToken, SESSION_SECONDS } from '@thesis/services';
import { eq, users } from '@thesis/db';
import { json, publicationDb, publicationFailure, requestJson, SESSION_COOKIE, viewerId } from '@/lib/publication-http';
export async function POST(request: Request) {
  try {
    const body = z.strictObject({ displayName: z.string().trim().min(2).max(40) }).parse(await requestJson(request));
    const secret = process.env.SESSION_SECRET ?? '';
    if (secret.length < 32) throw new PublicationError('session_not_configured', 503);
    const db = publicationDb();
    const id = await viewerId();
    const [existing] = id ? await db.select().from(users).where(eq(users.id, id)) : [];
    const user = existing ?? await createGuest(db, body.displayName);
    (await cookies()).set(SESSION_COOKIE, sessionToken(user.id, secret), { httpOnly: true,
      secure: new URL(request.url).protocol === 'https:', sameSite: 'lax', path: '/', maxAge: SESSION_SECONDS });
    return json({ displayName: user.displayName, paperBalanceUsd: user.paperBalanceUsd }, existing ? 200 : 201);
  } catch (error) { return publicationFailure(error); }
}
