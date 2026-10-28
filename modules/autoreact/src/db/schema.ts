import { guildTable } from '@bronto/core/tables';
import { boolean, pgSchema, text } from 'drizzle-orm/pg-core';

export const autoreactSchema = pgSchema('autoreact');

/** One rule per channel or thread, edited by people. Channel names are not stored; they are resolved live. */
export const rules = guildTable(autoreactSchema, 'rules', {
  channelId: text('channel_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  /** Skips posts of bots and webhooks. */
  ignoreBots: boolean('ignore_bots').notNull().default(true),
  /** Unicode emojis as characters, custom emojis as `<:name:id>` or `<a:name:id>`; reactions are added in this order. */
  emojis: text('emojis').array().notNull(),
  /** Members whose posts get no reactions. */
  ignoredUserIds: text('ignored_user_ids').array().notNull().default([]),
});

export type Rule = typeof rules.$inferSelect;
