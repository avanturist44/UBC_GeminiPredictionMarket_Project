import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ThesisDetail } from '@/components/thesis-detail';
import { getSessionUser } from '@/lib/session';
import { loadThesis } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  // Without a viewer only public theses load, so a private headline never reaches a page title.
  const loaded = await loadThesis(id, null);
  return { title: loaded.ok ? loaded.data.thesis.headline : 'Thesis' };
}

export default async function ThesisPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadThesis(id, await getSessionUser());
  if (!loaded.ok && loaded.status === 404) notFound();
  return <ThesisDetail id={id} initial={loaded.ok ? loaded.data : undefined} />;
}
