import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { MIGRATIONS_SCHEMA } from './constants.js';
import type { Database } from './database.js';
import { withMigrationLock } from './lock.js';
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
  assertTargetNames(targets);
  await withMigrationLock(database, (client) => applyMigrations(client, targets));
}

export function assertTargetNames(targets: MigrationTarget[]): void {
  for (const target of targets) {
    assertModuleName(target.name);
  }
}

/** Applies migrations on a connection that already holds the migration lock. */
export async function applyMigrations(client: pg.PoolClient, targets: MigrationTarget[]): Promise<void> {
  const db = drizzle({ client });
  for (const target of targets) {
    await migrate(db, {
      migrationsFolder: target.folder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: target.name,
    });
  }
}
