import { guildTable } from '@bronto/core/tables';
import { pgSchema, text } from 'drizzle-orm/pg-core';

export const notesSchema = pgSchema('notes');

export const notes = guildTable(notesSchema, 'notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
});
