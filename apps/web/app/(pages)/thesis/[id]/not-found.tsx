import Link from 'next/link';

export default function ThesisNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Thesis not found</h1>
      <p className="text-sm">
        There is no published thesis at this address.{' '}
        <Link href="/" className="text-primary underline-offset-4 hover:underline">
          See the latest theses
        </Link>
      </p>
    </div>
  );
}
