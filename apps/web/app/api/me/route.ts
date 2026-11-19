import { eq, users } from '@thesis/db';
import { PublicationError } from '@thesis/services';
import { json, publicationDb, publicationFailure, viewerId } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const id = await viewerId();
    if (!id) throw new PublicationError('session_required', 401);
    const [user] = await publicationDb().select().from(users).where(eq(users.id, id));
    if (!user) throw new PublicationError('session_required', 401);
    return json({ displayName: user.displayName, paperBalanceUsd: user.paperBalanceUsd,
      maxPerTradeUsd: user.maxPerTradeUsd, dailyCapUsd: user.dailyCopyCapUsd, mode: 'paper' });
  } catch (error) { return publicationFailure(error); }
}
