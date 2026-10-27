import { guildTable } from '@bronto/core/tables';
import { boolean, pgSchema, text } from 'drizzle-orm/pg-core';

export const mediaonlySchema = pgSchema('mediaonly');

/** One rule per channel or thread, edited by people. Channel names are not stored; they are resolved live. */
export const rules = guildTable(mediaonlySchema, 'rules', {
  channelId: text('channel_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  /** Skips posts of bots and webhooks. */
  ignoreBots: boolean('ignore_bots').notNull().default(true),
  /** Every attachment must be a spoiler and every link inside `||…||`. */
  requireSpoiler: boolean('require_spoiler').notNull().default(false),
  /** The channel or thread reports go to. */
  logChannelId: text('log_channel_id'),
  /** Set when the log channel is a thread: reports are sent into it through its parent's webhook. */
  logThreadId: text('log_thread_id'),
  logWebhookId: text('log_webhook_id'),
  /** Secret; never displayed or logged. */
  logWebhookToken: text('log_webhook_token'),
});

export type Rule = typeof rules.$inferSelect;
