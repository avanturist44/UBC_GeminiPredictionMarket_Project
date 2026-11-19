import { ThesisFeed } from '@/components/thesis-feed';
import { loadFeed } from '@/lib/thesis-data';
export const dynamic = 'force-dynamic';
export default async function Home() { return <ThesisFeed kind="agent" initial={await loadFeed('agent')} />; }
