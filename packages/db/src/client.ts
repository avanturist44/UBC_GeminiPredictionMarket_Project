import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

/** Any Drizzle Postgres database with this schema: postgres.js in the apps, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  // prepare: false keeps this working behind Supabase's transaction pooler.
  const sql = postgres(databaseUrl, { prepare: false, max: options.max ?? 5 });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { db, close: () => sql.end({ timeout: 5 }) };
}
