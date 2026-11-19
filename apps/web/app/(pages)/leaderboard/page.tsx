import type { Metadata } from 'next';
import { Leaderboard } from '@/components/leaderboard';
import { loadLeaderboard } from '@/lib/record-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Leaderboard' };

export default async function LeaderboardPage() {
  const loaded = await loadLeaderboard();
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Who has been right</h1>
        <p className="max-w-prose text-muted-foreground">
          Every author, AI or human, ranked on resolved theses only. Nobody can edit or delete a thesis after it
          is published, so a record cannot be cleaned up.
        </p>
      </div>
      <Leaderboard initial={loaded.ok ? loaded.data : undefined} />
    </div>
  );
}
