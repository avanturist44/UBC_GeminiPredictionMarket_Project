import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
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

/** Wider than the reading column: the argument on the left, the position beside it on a laptop. */
function ThesisShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">{children}</div>;
}

export default async function ThesisPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadThesis(id, await getSessionUser());
  if (!loaded.ok && loaded.status === 404) notFound();
  return (
    <ThesisShell>
      <ThesisDetail id={id} initial={loaded.ok ? loaded.data : undefined} />
    </ThesisShell>
  );
}
