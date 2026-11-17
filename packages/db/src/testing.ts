import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from './client';
import { migrationsFolder } from './migrate';
import * as schema from './schema';

/** An in-memory Postgres with every migration applied, for tests. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}
