import { ensureAppRole } from './app-role.js';
import { checkSchemasWith, type SchemaExpectation, type SchemaProblem } from './checks.js';
import type { Database } from './database.js';
import { grantRoles } from './grants.js';
import { withMigrationLock } from './lock.js';
import { applyMigrations, assertTargetNames, coreMigrationTarget, type MigrationTarget } from './migrate.js';
import { ensureModuleRoles } from './module-roles.js';

export interface PrepareOptions {
  /** Module migration targets, applied in this order after core. */
  modules: MigrationTarget[];
  expectations: SchemaExpectation[];
}

/**
 * Startup schema work, in this order: creates the app role if needed, migrates core and then each module, creates the
 * module roles, grants core to the app role and each module schema to its module role, and checks guild isolation.
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
    await ensureAppRole(client, database);
    await applyMigrations(client, targets);
    const moduleNames = modules.map((target) => target.name);
    await ensureModuleRoles(client, database.appRole, moduleNames);
    await grantRoles(client, database.appRole, [coreMigrationTarget.name, ...moduleNames]);
    return checkSchemasWith(client, expectations);
  });
}
