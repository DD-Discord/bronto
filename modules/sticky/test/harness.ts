import type { LoadedModule } from '@bronto/core';
import { stickyConfigSchema } from '../src/config.js';
import * as schema from '../src/db/schema.js';

/** The sticky module as the loader returns it; a stand-in until the full module exists. */
export function stickyModule(): LoadedModule {
  return {
    packageName: '@bronto/sticky',
    definition: { name: 'sticky', db: { schema, migrations: new URL('../drizzle/', import.meta.url) } },
    config: stickyConfigSchema.parse({}),
  };
}
