import type { Metadata } from 'next';
import Link from 'next/link';
import { Feed } from '@/components/feed';
import { Button } from '@/components/ui/button';
import { loadFeed } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Humans' };

export default async function HumansPage() {
  const loaded = await loadFeed('human');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Theses from people</h1>
        <Button asChild>
          <Link href="/write">Write a thesis</Link>
        </Button>
      </div>
      <Feed kind="human" initial={loaded.ok ? loaded.data : undefined} />
    </div>
  );
}
