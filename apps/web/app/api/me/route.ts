import { getAccount, PublicationError } from '@thesis/services';
import { json, publicationDb, publicationFailure, viewerId } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const id = await viewerId();
    if (!id) throw new PublicationError('session_required', 401);
    return json(await getAccount(publicationDb(), id));
  } catch (error) { return publicationFailure(error); }
}
