import 'server-only';
import { createDb, type Db } from '@thesis/db';

// One pool per server process, kept across hot reloads in development.
const globalForDb = globalThis as unknown as { thesisDb?: Db };

/** Null when DATABASE_URL is not configured, so pages can say so instead of crashing. */
export function getDb(): Db | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalForDb.thesisDb ??= createDb(url, { max: 3 }).db;
  return globalForDb.thesisDb;
}
