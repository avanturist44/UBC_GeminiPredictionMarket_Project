import 'server-only';
import { buildArenaMock } from './arena-mock';
import type { ArenaResponse } from './arena-view';
import type { Loaded } from './market-data';

/**
 * Loads the arena for its page, its API route and the card on Home.
 *
 * SAMPLE DATA for now: the multi-model agents live on another branch. When they are
 * merged, build an `ArenaResponse` from their trades here (as `lib/race.ts` does for the
 * two agents on this branch) and set `sample: false`. Nothing else needs to change.
 */
export async function loadArena(now: Date = new Date()): Promise<Loaded<ArenaResponse>> {
  return { ok: true, data: buildArenaMock(now) };
}
