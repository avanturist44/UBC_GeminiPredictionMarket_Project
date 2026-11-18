/**
 * Ten write requests a minute per session. Counts are kept in this server process, so on
 * a serverless host each warm instance counts on its own: enough to stop a runaway client,
 * and the database's own rules (one thesis per market, one audit at a time) are the real guard.
 */

const WINDOW_MS = 60_000;
const LIMIT = 10;
const hits = new Map<string, number[]>();

/** True if this request is within the limit. Records it either way. */
export function allowWrite(sessionKey: string, now = Date.now()): boolean {
  const recent = (hits.get(sessionKey) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  hits.set(sessionKey, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(key);
  }
  return recent.length <= LIMIT;
}
