import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RaceDetail } from '@/components/race-detail';
import { loadRace } from '@/lib/race-data';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ pair: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { pair } = await params;
  const loaded = await loadRace(pair);
  return { title: loaded.ok ? `${loaded.data.a.name} vs ${loaded.data.b.name}` : 'Agent race' };
}

export default async function RacePage({ params }: Props) {
  const { pair } = await params;
  const loaded = await loadRace(pair);
  if (!loaded.ok && loaded.status === 404) notFound();
  // If the first read failed, the page reads again in the browser and shows the error.
  return <RaceDetail pair={pair} initial={loaded.ok ? loaded.data : undefined} />;
}
