import { guildTable } from '@bronto/core/tables';
import { boolean, integer, pgSchema, text } from 'drizzle-orm/pg-core';

export const autothreadSchema = pgSchema('autothread');

/** One rule per channel, edited by people. Channel names are not stored; they are resolved live. */
export const rules = guildTable(autothreadSchema, 'rules', {
  channelId: text('channel_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  /** Skips posts of bots and webhooks. */
  ignoreBots: boolean('ignore_bots').notNull().default(true),
  /** Thread name with placeholders such as `{user.display}`. */
  nameFormat: text('name_format').notNull().default('[Comments] {user.display}'),
  /** Slowmode of new threads in seconds; 0 leaves it off. */
  slowmodeSeconds: integer('slowmode_seconds').notNull().default(0),
  /** Template posted as the first message of each thread; null posts none. A template ID, not a reference. */
  templateId: text('template_id'),
  /** Lets the post's author rename the thread. */
  rename: boolean('rename').notNull().default(false),
});

export type Rule = typeof rules.$inferSelect;
