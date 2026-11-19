import type { Metadata } from 'next';
import { ArenaDetail } from '@/components/arena-detail';
import { loadArena } from '@/lib/arena-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Model arena' };

/** Full width, outside the reading column: the chart is the page. */
export default async function ArenaPage() {
  const loaded = await loadArena();
  return <ArenaDetail initial={loaded.ok ? loaded.data : undefined} />;
}
