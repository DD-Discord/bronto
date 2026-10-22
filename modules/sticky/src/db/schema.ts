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
  /** The template it posts, from the templates module; no foreign key, since modules don't share tables. */
  templateId: text('template_id').notNull(),
  /** Location of the message a sticky copied before it used templates; unused. */
  templateChannelId: text('template_channel_id'),
  templateMessageId: text('template_message_id'),
  /** The copied message of a sticky from before templates; null once it uses its template only. */
  content: text('content'),
  embeds: jsonb('embeds').$type<APIEmbed[]>(),
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
