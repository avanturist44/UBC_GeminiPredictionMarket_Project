import { loadRace } from '@/lib/race-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** Two agents' account values over time, their open positions and their latest reasoning. */
export async function GET(_request: Request, { params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  return respond(await loadRace(pair));
}
