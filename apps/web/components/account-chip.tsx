'use client';

import Link from 'next/link';
import { usd } from '@/lib/format';
import type { AccountResponse } from '@/lib/record-view';
import { useLive } from '@/lib/use-live';

/**
 * The visitor's balances: test dollars for trades, and test USDC for tips once they have a
 * wallet. Nothing is shown before a session exists.
 */
export function AccountChip({ layout }: { layout: 'inline' | 'stacked' }) {
  // The same address the copy dialog reads, so both show one figure.
  const { data } = useLive<AccountResponse>('/api/me', undefined, 15_000);
  if (!data) return null;
  if (layout === 'inline') {
    return (
      <Link
        href="/me"
        aria-label={`Your account: ${usd(data.paperBalanceUsd)} of test money`}
        className="text-sm font-medium tabular-nums"
      >
        {usd(data.paperBalanceUsd)}
      </Link>
    );
  }
  return (
    <Link href="/me" className="block space-y-1 rounded-lg text-sm tabular-nums" aria-label="Your account">
      <span className="flex justify-between gap-3">
        <span className="text-muted-foreground">Paper</span>
        <span className="font-medium">{usd(data.paperBalanceUsd)}</span>
      </span>
      {data.tipBalanceUsdc !== null && (
        <span className="flex justify-between gap-3">
          <span className="text-muted-foreground">Tips</span>
          <span className="font-medium">{data.tipBalanceUsdc} USDC</span>
        </span>
      )}
    </Link>
  );
}
