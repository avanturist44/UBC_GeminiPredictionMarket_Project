import { NextResponse } from 'next/server';
import { allowWrite } from '@/lib/rate-limit';
import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';
import { loadComments, postComment } from '@/lib/social-data';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/** A published thesis's comments, oldest first. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(await loadComments((await params).id, await getSessionUser()));
}

/**
 * Posts a comment for the signed-in guest. Body: `{ body }`, 1 to 500 characters. Comments
 * that claim inside information are refused, as theses are.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'Start a session first.');
  if (!allowWrite(`user:${user.id}`)) return error(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  const result = await postComment(user, (await params).id, await request.json().catch(() => null), new Date());
  if (!result.ok) return respond(result);
  return NextResponse.json(result.data, { status: 201, headers: { 'cache-control': 'no-store' } });
}
