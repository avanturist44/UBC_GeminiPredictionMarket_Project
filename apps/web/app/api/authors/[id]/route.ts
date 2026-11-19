import { authorProfile } from '@thesis/services';
import { json, publicationDb, publicationFailure } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await authorProfile(publicationDb(), id, new URL(request.url).searchParams.get('cursor') ?? undefined);
    return result ? json(result) : json({ message: 'No public author record was found.' }, 404);
  } catch (error) { return publicationFailure(error); }
}
