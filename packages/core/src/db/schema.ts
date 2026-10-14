import { boolean, primaryKey, text } from 'drizzle-orm/pg-core';
import { core, guilds } from './core-schema.js';
import { guildTable } from './tables.js';

export { core, guilds };

/** Per-guild module switch; no row means the deployment default applies. */
export const guildModules = guildTable(
  core,
  'guild_modules',
  {
    module: text('module').notNull(),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.module] })],
);
