import { MIGRATIONS_SCHEMA } from './constants.js';
import type { Database } from './database.js';
import { withMigrationLock } from './lock.js';
import { assertModuleName, quoteIdent } from './names.js';

/**
 * Drops a module's schema and migration history. Callers make sure no loaded module depends on it. Holds the
 * migration lock so a concurrent start cannot migrate the module while it is being dropped.
 */
export async function purgeModuleSchema(database: Database, name: string): Promise<void> {
  assertModuleName(name);
  if (name === 'core') {
    throw new Error('The core schema cannot be purged.');
  }
  await withMigrationLock(database, (client) =>
    client.query(`
      drop schema if exists ${quoteIdent(name)} cascade;
      drop table if exists ${quoteIdent(MIGRATIONS_SCHEMA)}.${quoteIdent(name)};
    `),
  );
}

/** Modules that have a migration history in this database, including core. */
export async function listMigratedModules(database: Database): Promise<string[]> {
  const { rows } = await database.adminPool.query<{ name: string }>(
    'select table_name as name from information_schema.tables where table_schema = $1 order by table_name',
    [MIGRATIONS_SCHEMA],
  );
  return rows.map((row) => row.name);
}
