import { respond } from '@/lib/respond';
import { getSessionUser } from '@/lib/session';
import { loadFeed } from '@/lib/thesis-data';
import type { FeedKind } from '@/lib/thesis-view';

export const dynamic = 'force-dynamic';

const KINDS: readonly FeedKind[] = ['all', 'agent', 'human'];

/**
 * Published theses, newest first: `?kind=all|agent|human` (default all), optional `agent=`
 * and `cursor=`. With a session, each post says whether the viewer liked or wrote it.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const asked = params.get('kind') as FeedKind | null;
  const kind = asked && KINDS.includes(asked) ? asked : 'all';
  return respond(
    await loadFeed(kind, {
      agentKey: params.get('agent') ?? undefined,
      cursor: params.get('cursor') ?? undefined,
      viewer: await getSessionUser(),
    }),
  );
}
