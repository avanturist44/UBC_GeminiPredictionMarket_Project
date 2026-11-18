import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';
import { loadThesis } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

/** One thesis with its full audit, its author's position, tips and on-chain identifiers. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(await loadThesis(id, await getSessionUser()));
}
