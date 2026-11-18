import { respond } from '@/lib/respond';
import { loadFeed } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

/** Published theses, newest first: `?kind=agent|human`, optional `agent=` and `cursor=`. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind') === 'human' ? 'human' : 'agent';
  return respond(
    await loadFeed(kind, { agentKey: params.get('agent') ?? undefined, cursor: params.get('cursor') ?? undefined }),
  );
}
