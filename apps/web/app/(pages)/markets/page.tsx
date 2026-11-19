import type { Metadata } from 'next';
import { MarketsList } from '@/components/markets-list';
import { loadMarkets } from '@/lib/market-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Markets' };

type Props = { searchParams: Promise<{ topic?: string }> };

export default async function MarketsPage({ searchParams }: Props) {
  const { topic } = await searchParams;
  const loaded = await loadMarkets();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-medium">Markets</h1>
      {/* If the first read failed, the list fetches again in the browser and shows the error. */}
      <MarketsList
        initial={loaded.ok ? loaded.data : undefined}
        initialTopic={topic && /^[a-z0-9-]{1,40}$/.test(topic) ? topic : 'all'}
      />
    </div>
  );
}
