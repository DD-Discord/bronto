import { defineModule, type ModuleDefinition } from '../../../src/runtime/module.js';
import * as schema from './schema.js';

export const widgetsMigrations = new URL('./drizzle/', import.meta.url);

/** A test module owning the widgets schema; overrides add hooks or listeners per test. */
export function widgetsModule(overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return defineModule({ name: 'widgets', db: { schema, migrations: widgetsMigrations }, ...overrides });
}
