import Link from 'next/link';

export default function ThesisNotFound() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-10">
      <div className="max-w-prose space-y-3">
        <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">Thesis not found</h1>
        <p className="text-sm">
          There is no published thesis at this address.{' '}
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            See the latest theses
          </Link>
        </p>
      </div>
    </div>
  );
}
