import { loadAuthor } from '@/lib/record-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** One author: profile, record, an agent's limits and status, and their public theses. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(await loadAuthor((await params).id));
}
