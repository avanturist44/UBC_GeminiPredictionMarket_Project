import { loadLeaderboard } from '@/lib/record-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** Every author with a public thesis: record, Brier score, profit and thesis count. */
export async function GET() {
  return respond(await loadLeaderboard());
}
