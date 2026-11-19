import { loadArena } from '@/lib/arena-data';
import { respond } from '@/lib/respond';

export const dynamic = 'force-dynamic';

/** Every model's account value over time, its settled trades, open positions and messages. */
export async function GET() {
  return respond(await loadArena());
}
