import { getThesisView } from '@thesis/services';
import { json, publicationDb, publicationFailure, viewerId } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const thesis = await getThesisView(publicationDb(), id, await viewerId());
    return thesis ? json({ asOf: new Date().toISOString(), thesis }) : json({ code: 'not_found', message: 'Thesis not found.' }, 404);
  } catch (error) { return publicationFailure(error); }
}
