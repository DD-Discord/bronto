import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { MIGRATION_LOCK_KEY, MIGRATIONS_SCHEMA } from './constants.js';
import type { Database } from './database.js';
import { assertModuleName } from './names.js';

export interface MigrationTarget {
  /** Module name; its history is the table `migrations.<name>`. */
  name: string;
  /** Absolute path of the folder drizzle-kit generated. */
  folder: string;
}

export const coreMigrationTarget: MigrationTarget = {
  name: 'core',
  folder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
};

/** Applies pending migrations of each target in order. An advisory lock makes concurrent starts wait for each other. */
export async function migrateAll(database: Database, targets: MigrationTarget[]): Promise<void> {
  for (const target of targets) {
    assertModuleName(target.name);
  }
  const client = await database.adminPool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const db = drizzle({ client });
      for (const target of targets) {
        await migrate(db, {
          migrationsFolder: target.folder,
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: target.name,
        });
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
