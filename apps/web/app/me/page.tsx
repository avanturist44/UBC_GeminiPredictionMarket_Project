import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Account } from '@/components/account';
import { Button } from '@/components/ui/button';
import { loadAccount } from '@/lib/record-data';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Me' };

/** Wider than the reading column: the account reads as a profile, with its figures in a row. */
function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">{children}</div>;
}

export default async function MePage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <Shell>
        <div className="max-w-prose space-y-4">
          <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">You have no session yet</h1>
          <p>
            There is no sign-up. A guest session starts on this browser, with $1,000 of test money, the first time
            you copy a trade or publish a thesis. Your positions, tips and limits then show here.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/">Find a thesis to copy</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/write">Write a thesis</Link>
            </Button>
          </div>
        </div>
      </Shell>
    );
  }
  const loaded = await loadAccount(user);
  if (!loaded.ok) {
    return (
      <Shell>
        <div className="max-w-prose space-y-3">
          <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">Your account could not be read</h1>
          <p role="alert" className="text-sm">
            {loaded.error.message}{' '}
            <Link href="/me" className="text-primary underline-offset-4 hover:underline">
              Try again
            </Link>
          </p>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <Account initial={loaded.data} />
    </Shell>
  );
}
