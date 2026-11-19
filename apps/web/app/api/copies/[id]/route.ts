import { getCopy, PublicationError } from '@thesis/services';
import { json, publicationDb, publicationFailure, viewerId } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await viewerId(); if (!userId) throw new PublicationError('session_required', 401);
    const copy = await getCopy(publicationDb(), (await context.params).id, userId);
    return copy ? json(copy) : json({ code: 'not_found', message: 'Copy request not found.' }, 404);
  } catch (error) { return publicationFailure(error); }
}
