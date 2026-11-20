import { EXT_CORS_HEADERS, loadExtMarkets } from '@/lib/ext-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/**
 * For the Chrome extension: tracked markets that have not expired, each with its keyword
 * groups, most theses first. The extension matches posts against these in the browser.
 */
export async function GET() {
  return respond(await loadExtMarkets(), EXT_CORS_HEADERS);
}
