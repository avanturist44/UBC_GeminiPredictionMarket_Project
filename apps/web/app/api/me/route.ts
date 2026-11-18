import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { toMe } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

/** The signed-in guest: name, paper balance and per-trade limit. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ code: 'no_session', message: 'No session.' }, { status: 401 });
  return NextResponse.json(toMe(user), { headers: { 'cache-control': 'no-store' } });
}
