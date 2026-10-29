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

/** One rule per channel with an optional log channel, like a module's channel rules. */
export const widgetRules = guildTable(widgets, 'rules', {
  channelId: text('channel_id').primaryKey(),
  logChannelId: text('log_channel_id'),
  logThreadId: text('log_thread_id'),
  logWebhookId: text('log_webhook_id'),
  logWebhookToken: text('log_webhook_token'),
});
