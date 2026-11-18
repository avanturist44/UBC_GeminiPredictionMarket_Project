import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MarketDetail } from '@/components/market-detail';
import { loadMarketDetail } from '@/lib/market-data';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ symbol: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { symbol } = await params;
  const loaded = await loadMarketDetail(symbol);
  return { title: loaded.ok ? loaded.data.market.title : 'Market' };
}

export default async function MarketPage({ params }: Props) {
  const { symbol } = await params;
  const loaded = await loadMarketDetail(symbol);
  if (!loaded.ok && loaded.status === 404) notFound();
  // If the first read failed, the page fetches again in the browser and shows the error.
  return <MarketDetail symbol={symbol} initial={loaded.ok ? loaded.data : undefined} />;
}
