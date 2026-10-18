import { ensureAppRole } from './app-role.js';
import { checkSchemasWith, type SchemaExpectation, type SchemaProblem } from './checks.js';
import type { Database } from './database.js';
import { grantRoles, revokeUnloadedModules } from './grants.js';
import { withMigrationLock } from './lock.js';
import { applyMigrations, assertTargetNames, coreMigrationTarget, type MigrationTarget } from './migrate.js';
import { ensureModuleRoles } from './module-roles.js';

export interface PrepareOptions {
  /** Module migration targets, applied in this order after core. */
  modules: MigrationTarget[];
  expectations: SchemaExpectation[];
}

const MIN_POSTGRES_VERSION_NUM = 160000;

/** Module roles need Postgres 16's role membership options (SET, INHERIT) and `pg_has_role(..., 'SET')`. */
export function assertPostgresVersion(versionNum: number): void {
  if (versionNum >= MIN_POSTGRES_VERSION_NUM) return;
  const found = `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`;
  throw new Error(`Postgres 16 or newer is required (found ${found}).`);
}

/**
 * Startup schema work, in this order: requires Postgres 16 or newer, creates the app role if needed, migrates core and
 * then each module, creates the module roles, grants core to the app role and each module schema to its module role,
 * takes the app role off the schemas of migrated modules that are not loaded, and checks guild isolation.
 * All of it runs on one connection holding the migration lock, so concurrent starts cannot interleave. Returns the
 * problems found; the caller decides whether to refuse to start.
 */
export async function prepareDatabase(database: Database, options: PrepareOptions): Promise<SchemaProblem[]> {
  const { modules, expectations } = options;
  assertTargetNames(modules);
  if (modules.some((target) => target.name === coreMigrationTarget.name)) {
    throw new Error('Module targets must not include core; prepareDatabase always migrates core first.');
  }
  const targets = [coreMigrationTarget, ...modules];
  return withMigrationLock(database, async (client) => {
    const { rows } = await client.query<{ version: number }>(
      `select current_setting('server_version_num')::int as "version"`,
    );
    assertPostgresVersion(rows[0]!.version);
    await ensureAppRole(client, database);
    await applyMigrations(client, targets);
    const moduleNames = modules.map((target) => target.name);
    await ensureModuleRoles(client, database.appRole, moduleNames);
    await grantRoles(client, database.appRole, [coreMigrationTarget.name, ...moduleNames]);
    await revokeUnloadedModules(client, database.appRole, moduleNames);
    return checkSchemasWith(client, expectations);
  });
}
