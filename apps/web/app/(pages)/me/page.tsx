import type { Metadata } from 'next';
import Link from 'next/link';
import { Account } from '@/components/account';
import { Button } from '@/components/ui/button';
import { loadAccount } from '@/lib/record-data';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Me' };

export default async function MePage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">You have no session yet</h1>
        <p className="max-w-prose">
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
    );
  }
  const loaded = await loadAccount(user);
  if (!loaded.ok) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your account could not be read</h1>
        <p role="alert" className="text-sm">
          {loaded.error.message}{' '}
          <Link href="/me" className="text-primary underline-offset-4 hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }
  return <Account initial={loaded.data} />;
}
