import { NextResponse } from 'next/server';
import { loadAccount } from '@/lib/record-data';
import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** The signed-in guest: balances, limits, today's total, positions and tips. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ code: 'no_session', message: 'No session.' }, { status: 401 });
  return respond(await loadAccount(user));
}
