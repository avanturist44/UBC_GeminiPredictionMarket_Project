import { changeLimits, consumeUserWrite, PublicationError } from '@thesis/services';
import { json, publicationDb, publicationFailure, requestJson, viewerId } from '@/lib/publication-http';
export async function PATCH(request: Request) {
  try {
    const input = await requestJson(request), id = await viewerId();
    if (!id) throw new PublicationError('session_required', 401);
    const db = publicationDb(); await consumeUserWrite(db, id);
    return json(await changeLimits(db, id, input));
  } catch (error) { return publicationFailure(error); }
}
