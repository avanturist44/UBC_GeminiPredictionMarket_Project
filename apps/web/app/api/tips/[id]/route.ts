import { and, eq, tips } from '@thesis/db';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import type { TipStatusResponse } from '@/lib/thesis-view';

export const dynamic = 'force-dynamic';

const error = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

/** Where one of the signed-in user's tips is: pending, in escrow, paid, refunded or failed. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  if (!db) return error(503, 'not_configured', 'No database is connected.');
  const user = await getSessionUser();
  if (!user) return error(401, 'no_session', 'No session.');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return error(404, 'not_found', 'No such tip.');
  try {
    const [tip] = await db.select().from(tips).where(and(eq(tips.id, id), eq(tips.userId, user.id))).limit(1);
    if (!tip) return error(404, 'not_found', 'No such tip.');
    const body: TipStatusResponse = {
      id: tip.id,
      status: tip.status,
      amountUsdc: tip.amountUsdc,
      depositTx: tip.depositTx,
      settleTx: tip.settleTx,
    };
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    console.error('tip status query failed', cause);
    return error(503, 'db_error', 'The tip could not be read. Try again in a moment.');
  }
}
