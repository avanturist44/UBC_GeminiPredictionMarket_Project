import { MarketsListSkeleton } from '@/components/markets-list';

export default function Loading() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
      <MarketsListSkeleton />
    </div>
  );
}
