import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { auditColumns } from './audit.js';
import { markGlobalTable } from './registry.js';

export const core = pgSchema('core');

/** One row per guild the bot has seen; deleting a row cascades into every guild table. */
export const guilds = markGlobalTable(
  core.table('guilds', {
    id: text('id').primaryKey(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    ...auditColumns(),
  }),
);
