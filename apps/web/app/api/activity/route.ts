import { loadActivity } from '@/lib/record-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** The latest tips paid to authors or returned to tippers, for the live strip. */
export async function GET() {
  return respond(await loadActivity());
}
