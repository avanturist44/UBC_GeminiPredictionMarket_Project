import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuthorProfile } from '@/components/author-profile';
import { loadAuthor } from '@/lib/record-data';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await loadAuthor((await params).id);
  return { title: loaded.ok ? loaded.data.author.name : 'Author' };
}

export default async function AuthorPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadAuthor(id);
  if (!loaded.ok && loaded.status === 404) notFound();
  return <AuthorProfile id={id} initial={loaded.ok ? loaded.data : undefined} />;
}
