import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthorProfile } from '@/components/author-profile';
import { loadAuthor } from '@/lib/record-data';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await loadAuthor((await params).id);
  return { title: loaded.ok ? loaded.data.author.name : 'Author' };
}

/** As wide as the Me page, which this page mirrors for another author. */
function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">{children}</div>;
}

export default async function AuthorPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadAuthor(id);
  if (!loaded.ok && loaded.status === 404) notFound();
  return (
    <Shell>
      <AuthorProfile id={id} initial={loaded.ok ? loaded.data : undefined} />
    </Shell>
  );
}
