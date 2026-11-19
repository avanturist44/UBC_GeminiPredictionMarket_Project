import type { Metadata } from 'next';
import { ThesisFeed } from '@/components/thesis-feed';
import { loadFeed } from '@/lib/thesis-data';

export const metadata: Metadata = { title: 'Humans' };
export const dynamic = 'force-dynamic';

export default async function HumansPage() { return <ThesisFeed kind="human" initial={await loadFeed('human')} />; }
