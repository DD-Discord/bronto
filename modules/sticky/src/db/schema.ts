import { guildTable } from '@bronto/core/tables';
import type { APIEmbed } from 'discord.js';
import { boolean, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const stickySchema = pgSchema('sticky');

/** Sticky settings, edited by people. Channel names are not stored; they are resolved live. */
export const stickies = guildTable(stickySchema, 'stickies', {
  /** Channel or thread the sticky lives in. */
  channelId: text('channel_id').primaryKey(),
  /** Set for threads: the webhook belongs to this parent channel. */
  parentChannelId: text('parent_channel_id'),
  webhookId: text('webhook_id').notNull(),
  /** Secret; never displayed. */
  webhookToken: text('webhook_token').notNull(),
  templateChannelId: text('template_channel_id').notNull(),
  templateMessageId: text('template_message_id').notNull(),
  content: text('content').notNull().default(''),
  embeds: jsonb('embeds').$type<APIEmbed[]>().notNull().default([]),
  ignoreBots: boolean('ignore_bots').notNull().default(true),
  silent: boolean('silent').notNull().default(true),
  debounceMs: integer('debounce_ms').notNull().default(0),
});

/** Runtime state of a sticky, written by the bot. */
export const stickyState = guildTable(stickySchema, 'sticky_state', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => stickies.channelId, { onDelete: 'cascade' }),
  /** The post currently in the channel. */
  lastMessageId: text('last_message_id'),
  /** When a debounced repost is due. */
  repostDueAt: timestamp('repost_due_at', { withTimezone: true }),
});

export type Sticky = typeof stickies.$inferSelect;
