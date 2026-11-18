import { loadMarketDetail } from '@/lib/market-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/**
 * One market: its quote, up to 500 price points, its public theses as chart markers, and
 * the disagreement summary (average AI probability, average human probability, market price).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return respond(await loadMarketDetail(symbol));
}
