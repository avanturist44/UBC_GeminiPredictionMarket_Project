'use client';

import Link from 'next/link';
import { usd } from '@/lib/format';
import type { AccountResponse } from '@/lib/record-view';
import { useLive } from '@/lib/use-live';

/**
 * The visitor's balances in the top bar: test dollars for trades, and test USDC for tips
 * once they have a wallet. Nothing is shown before a session exists.
 */
export function AccountChip() {
  // The same address the copy dialog reads, so both show one figure.
  const { data } = useLive<AccountResponse>('/api/me', undefined, 15_000);
  if (!data) return null;
  return (
    <Link
      href="/me"
      className="ml-auto text-right text-xs leading-tight tabular-nums underline-offset-4 hover:underline sm:text-sm"
      aria-label="Your account"
    >
      <span className="block sm:inline">
        <span className="text-muted-foreground">Paper</span> {usd(data.paperBalanceUsd)}
      </span>
      {data.tipBalanceUsdc !== null && (
        <span className="block sm:ml-3 sm:inline">
          <span className="text-muted-foreground">Tips</span> {data.tipBalanceUsdc} USDC
        </span>
      )}
    </Link>
  );
}
