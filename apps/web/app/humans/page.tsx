import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Humans' };

export default function HumansPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Theses from people</h1>
      <p className="rounded-lg border p-4 text-sm">
        No human theses yet. Writing one opens in a later build phase. Until then,{' '}
        <Link href="/markets" className="text-primary underline-offset-4 hover:underline">
          see the markets and their live odds
        </Link>
        .
      </p>
    </div>
  );
}
