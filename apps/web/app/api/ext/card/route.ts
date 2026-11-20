import { EXT_CORS_HEADERS, loadExtCard } from '@/lib/ext-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/**
 * For the Chrome extension: one market's card, `?symbol=`. Its YES price, the most trusted
 * public thesis (as an excerpt, never the whole text), and a summary of all of them.
 */
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol');
  return respond(await loadExtCard(symbol), EXT_CORS_HEADERS);
}
