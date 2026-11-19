import { redirect } from 'next/navigation';

/** The human feed is now a filter on Home. Old links keep working. */
export default function HumansPage() {
  redirect('/?show=humans');
}
