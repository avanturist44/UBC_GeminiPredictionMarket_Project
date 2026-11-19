import { leaderboard } from '@thesis/services';
import { json, publicationDb, publicationFailure } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return json(await leaderboard(publicationDb())); } catch (error) { return publicationFailure(error); }
}
