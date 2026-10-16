import { ensureAppRole } from './app-role.js';
import { checkSchemasWith, type SchemaExpectation, type SchemaProblem } from './checks.js';
import type { Database } from './database.js';
import { grantAppRoleWith } from './grants.js';
import { withMigrationLock } from './lock.js';
import { applyMigrations, assertTargetNames, coreMigrationTarget, type MigrationTarget } from './migrate.js';

export interface PrepareOptions {
  /** Module migration targets, applied in this order after core. */
  modules: MigrationTarget[];
  expectations: SchemaExpectation[];
}

/**
 * Startup schema work: creates the app role if needed, migrates core and then each module, grants the app role on every schema and checks guild
 * isolation. All of it runs on one connection holding the migration lock, so concurrent starts cannot interleave.
 * Returns the problems found; the caller decides whether to refuse to start.
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
    await grantAppRoleWith(client, database.appRole, targets.map((target) => target.name));
    return checkSchemasWith(client, expectations);
  });
}
