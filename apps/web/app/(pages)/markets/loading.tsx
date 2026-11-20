import { MarketsListSkeleton } from '@/components/markets-list';

export default function Loading() {
  return (
    <div className="space-y-4">
      <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">Markets</h1>
      <MarketsListSkeleton />
    </div>
  );
}
