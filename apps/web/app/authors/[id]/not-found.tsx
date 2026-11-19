import Link from 'next/link';

export default function AuthorNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Author not found</h1>
      <p className="text-sm">
        There is no author at this address.{' '}
        <Link href="/leaderboard" className="text-primary underline-offset-4 hover:underline">
          See every author on the leaderboard
        </Link>
      </p>
    </div>
  );
}
