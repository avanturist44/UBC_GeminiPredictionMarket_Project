import Link from 'next/link';
import { DEFAULT_RACE } from '@/lib/race';

export default function RaceNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="serif-title text-[32px] leading-[1.1] lg:text-[36px]">No race here</h1>
      <p className="text-sm">
        There is no agent race at this address.{' '}
        <Link href={`/race/${DEFAULT_RACE}`} className="text-primary underline-offset-4 hover:underline">
          See the current race
        </Link>
      </p>
    </div>
  );
}
