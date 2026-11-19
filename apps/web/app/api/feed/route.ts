import { listThesisFeed } from '@thesis/services';
import { json, publicationDb, publicationFailure } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return json(await listThesisFeed(publicationDb(), { kind: params.get('kind') ?? 'agent',
      agent: params.get('agent') ?? undefined, cursor: params.get('cursor') ?? undefined }));
  } catch (error) { return publicationFailure(error); }
}
