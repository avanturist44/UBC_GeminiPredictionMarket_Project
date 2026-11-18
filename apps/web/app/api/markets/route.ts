import { loadMarkets } from '@/lib/market-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** Tracked markets that have not expired, with odds, expiry and thesis counts per side. */
export async function GET() {
  return respond(await loadMarkets());
}
