import { integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { globalTable, guildTable } from '../../../src/db/tables.js';

export const widgets = pgSchema('widgets');

export const widgetItems = guildTable(widgets, 'items', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  count: integer('count').notNull().default(0),
});

export const widgetCatalog = globalTable(widgets, 'catalog', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});
