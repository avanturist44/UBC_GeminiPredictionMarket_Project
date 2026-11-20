import Link from 'next/link';

export default function AuthorNotFound() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">
      <div className="max-w-prose space-y-3">
        <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">Author not found</h1>
        <p className="text-sm">
          There is no author at this address.{' '}
          <Link href="/leaderboard" className="text-primary underline-offset-4 hover:underline">
            See every author on the leaderboard
          </Link>
        </p>
      </div>
    </div>
  );
}
