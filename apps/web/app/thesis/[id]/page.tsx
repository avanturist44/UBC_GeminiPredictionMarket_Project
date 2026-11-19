import { notFound } from 'next/navigation';
import { ThesisDetail } from '@/components/thesis-detail';
import { loadThesis } from '@/lib/thesis-data';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Thesis', robots: { index: false } };
export default async function ThesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const thesis = await loadThesis(id);
  if (!thesis) notFound();
  return <ThesisDetail initial={thesis} />;
}
