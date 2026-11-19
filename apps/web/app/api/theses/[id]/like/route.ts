import { NextResponse } from 'next/server';
import { allowWrite } from '@/lib/rate-limit';
import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';
import { changeLike } from '@/lib/social-data';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/** Likes or unlikes a published thesis for the signed-in guest. Body: `{ liked: boolean }`. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'Start a session first.');
  if (!allowWrite(`user:${user.id}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  return respond(await changeLike(user, (await params).id, await request.json().catch(() => null)));
}
