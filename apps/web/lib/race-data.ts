import 'server-only';
import { AGENT_RULES } from '@thesis/core';
import { getRaceData } from '@thesis/db';
import { getDb } from './db';
import type { Loaded } from './market-data';
import { RACES, RACE_SLOTS, buildRace } from './race';
import type { RaceResponse } from './race-view';
import { NOT_CONFIGURED } from './thesis-data';

/**
 * Loads a race for its page, its API route and the card on Home. Every open page re-reads
 * it every five seconds, so one result is shared for a few seconds per server process.
 */

const CACHE_MS = 4000;
const cache = new Map<string, { at: number; data: RaceResponse }>();

export async function loadRace(pair: string): Promise<Loaded<RaceResponse>> {
  const race = RACES[pair];
  if (!race) return { ok: false, status: 404, error: { code: 'not_found', message: 'There is no race at this address.' } };
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  const now = new Date();
  const hit = cache.get(pair);
  if (hit && now.getTime() - hit.at < CACHE_MS) return { ok: true, data: hit.data };
  try {
    const rows = await getRaceData(db, [race.a, race.b], { now, slots: RACE_SLOTS });
    const data = buildRace(pair, rows, { now, bankrollUsd: AGENT_RULES.bankrollUsd });
    cache.set(pair, { at: now.getTime(), data });
    return { ok: true, data };
  } catch (error) {
    console.error('race query failed', error);
    return { ok: false, status: 503, error: { code: 'db_error', message: 'The race could not be read. Try again in a moment.' } };
  }
}
