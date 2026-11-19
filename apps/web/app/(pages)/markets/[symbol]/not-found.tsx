import Link from 'next/link';

export default function MarketNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Market not found</h1>
      <p className="text-sm">
        No tracked market has this symbol.{' '}
        <Link href="/markets" className="text-primary underline-offset-4 hover:underline">
          See all markets
        </Link>
      </p>
    </div>
  );
}
