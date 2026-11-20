import 'server-only';
import { AGENT_RULES } from '@thesis/core';
import { getArenaData } from '@thesis/db';
import { ARENA_RUNS_PER_MODEL, ARENA_SLOTS, buildArena } from './arena';
import { buildArenaMock } from './arena-mock';
import type { ArenaResponse } from './arena-view';
import { getDb } from './db';
import type { Loaded } from './market-data';
import { NOT_CONFIGURED } from './thesis-data';

/**
 * Loads the arena for its page, its API route and the card on Home.
 *
 * With `ARENA_SOURCE=live` it is built from the arena models' real trades and looks, and says
 * `sample: false`; with no trades yet that is an empty arena, never sample numbers. Any other
 * value, or none, serves the generated sample. Every open page re-reads it every five
 * seconds, so a live result is shared for a few seconds per server process.
 */

const CACHE_MS = 4000;
let cached: { at: number; data: ArenaResponse } | null = null;

export async function loadArena(now: Date = new Date()): Promise<Loaded<ArenaResponse>> {
  if (process.env.ARENA_SOURCE?.trim() !== 'live') return { ok: true, data: buildArenaMock(now) };
  const db = getDb();
  if (!db) return NOT_CONFIGURED;
  if (cached && now.getTime() - cached.at < CACHE_MS) return { ok: true, data: cached.data };
  try {
    const rows = await getArenaData(db, { now, slots: ARENA_SLOTS, runsPerAgent: ARENA_RUNS_PER_MODEL });
    const data = buildArena(rows, { now, bankrollUsd: AGENT_RULES.bankrollUsd });
    cached = { at: now.getTime(), data };
    return { ok: true, data };
  } catch (error) {
    // The message can name the database host or user. Keep it in the server log.
    console.error('arena query failed', error);
    return { ok: false, status: 503, error: { code: 'db_error', message: 'The arena could not be read. Try again in a moment.' } };
  }
}
