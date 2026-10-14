import { fileURLToPath } from 'node:url';
import type { SchemaExpectation } from '../db/checks.js';
import type { MigrationTarget } from '../db/migrate.js';
import { globalTableNames } from '../db/registry.js';
import * as coreSchema from '../db/schema.js';
import type { LoadedModule } from './loader.js';

/** Migration folders of the modules that own tables, in load order. */
export function migrationTargets(modules: LoadedModule[]): MigrationTarget[] {
  return modules.flatMap(({ definition }) =>
    definition.db === undefined ? [] : [{ name: definition.name, folder: fileURLToPath(definition.db.migrations) }],
  );
}

/** What the startup checks expect: core plus every module with tables, each with its declared global tables. */
export function schemaExpectations(modules: LoadedModule[]): SchemaExpectation[] {
  return [
    { schema: 'core', globalTables: globalTableNames(coreSchema) },
    ...modules.flatMap(({ definition }) =>
      definition.db === undefined
        ? []
        : [{ schema: definition.name, globalTables: globalTableNames(definition.db.schema) }],
    ),
  ];
}
