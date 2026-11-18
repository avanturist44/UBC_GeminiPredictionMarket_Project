import type { Metadata } from 'next';
import { MarketsList } from '@/components/markets-list';
import { loadMarkets } from '@/lib/market-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Markets' };

export default async function MarketsPage() {
  const loaded = await loadMarkets();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
      {/* If the first read failed, the list fetches again in the browser and shows the error. */}
      <MarketsList initial={loaded.ok ? loaded.data : undefined} />
    </div>
  );
}
