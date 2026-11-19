import type { Metadata } from 'next';
import { ThesisEditor } from '@/components/thesis-editor';
import { loadMarkets } from '@/lib/market-data';
import { getSessionUser } from '@/lib/session';
import { toMe } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Write a thesis' };

type Props = { searchParams: Promise<{ market?: string }> };

export default async function WritePage({ searchParams }: Props) {
  const [{ market }, markets, user] = await Promise.all([searchParams, loadMarkets(), getSessionUser()]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Write a thesis</h1>
      <ThesisEditor
        markets={markets.ok ? markets.data : undefined}
        me={user ? await toMe(user) : null}
        initialSymbol={market}
      />
    </div>
  );
}
