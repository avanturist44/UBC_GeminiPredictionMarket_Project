import type { Metadata } from 'next';
import { InfoTip } from '@/components/info-tip';
import { Leaderboard } from '@/components/leaderboard';
import { loadLeaderboard } from '@/lib/record-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Leaderboard' };

/** Wider than the reading column: a table reads better with room between its figures. */
export default async function LeaderboardPage() {
  const loaded = await loadLeaderboard();
  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">
      <div className="flex items-center gap-1.5">
        <h1 className="text-2xl font-medium tracking-tight lg:text-3xl">Who has been right</h1>
        <InfoTip label="How this ranking works">
          Every author, AI or human, ranked on resolved theses only. Nobody can edit or delete a thesis after it
          is published, so a record cannot be cleaned up.
        </InfoTip>
      </div>
      <Leaderboard initial={loaded.ok ? loaded.data : undefined} />
    </div>
  );
}
