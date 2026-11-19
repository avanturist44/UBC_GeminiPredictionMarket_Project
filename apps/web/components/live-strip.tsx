'use client';

import Link from 'next/link';
import { activityText, type ActivityResponse } from '@/lib/record-view';
import { EXPLORER_TX, isTxHash } from '@/lib/thesis-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The strip under the top bar: the latest tips paid out of escrow or returned, each linking
 * to its transaction on the Arc explorer. It keeps one fixed height, so the page below does
 * not move when the first read arrives.
 */
export function LiveStrip() {
  const { data } = useLive<ActivityResponse>('/api/activity', undefined, 15_000);
  return (
    <div className="border-b border-border bg-card">
      <div className="flex h-9 items-center gap-3 overflow-x-auto px-4 text-[13px] whitespace-nowrap sm:px-6 lg:px-8">
        {data &&
          (data.items.length === 0 ? (
            <p className="text-muted-foreground">
              Tips wait in escrow until a market resolves. Payouts and refunds show here.
            </p>
          ) : (
            <ul className="flex gap-6">
              {data.items.map((item) => {
                const text = activityText(item);
                const tone = cn(
                  'underline-offset-4 hover:underline',
                  item.status === 'paid' ? 'text-foreground' : 'text-muted-foreground',
                );
                return (
                  <li key={item.tipId}>
                    {isTxHash(item.settleTx) ? (
                      <a href={`${EXPLORER_TX}${item.settleTx}`} target="_blank" rel="noreferrer" className={tone}>
                        {text}
                      </a>
                    ) : (
                      <Link href={`/thesis/${item.thesisId}`} className={tone}>
                        {text}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    </div>
  );
}
