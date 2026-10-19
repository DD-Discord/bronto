import { guildTable } from '@bronto/core/tables';
import { bigint, boolean, index, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const autodeleteSchema = pgSchema('autodelete');

/** One rule per channel, edited by people. Channel names are not stored; they are resolved live. */
export const rules = guildTable(autodeleteSchema, 'rules', {
  channelId: text('channel_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  keepLatest: boolean('keep_latest').notNull().default(true),
  deleteOnLeave: boolean('delete_on_leave').notNull().default(false),
  /** Time between two posts of one member; 0 is off. */
  cooldownMs: bigint('cooldown_ms', { mode: 'number' }).notNull().default(0),
  /** Time after a post in which deleting it resets the cooldown; 0 is off. */
  graceMs: bigint('grace_ms', { mode: 'number' }).notNull().default(0),
  notifyDm: boolean('notify_dm').notNull().default(false),
  /** The channel or thread reports go to. */
  logChannelId: text('log_channel_id'),
  /** Set when the log channel is a thread: reports are sent into it through its parent's webhook. */
  logThreadId: text('log_thread_id'),
  logWebhookId: text('log_webhook_id'),
  /** Secret; never displayed or logged. */
  logWebhookToken: text('log_webhook_token'),
});

/** The messages of a rule channel that are tracked and still exist. */
export const posts = guildTable(
  autodeleteSchema,
  'posts',
  {
    messageId: text('message_id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => rules.channelId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    /** From the message's snowflake. */
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('posts_member_idx').on(t.guildId, t.channelId, t.userId)],
);

/** The last accepted post of a member in a rule channel; it outlives the post. */
export const cooldowns = guildTable(
  autodeleteSchema,
  'cooldowns',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => rules.channelId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    /** The post the cooldown counts from. */
    messageId: text('message_id').notNull(),
    /** The cooldown runs from here; from the message's snowflake. */
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.channelId, t.userId] })],
);

export type Rule = typeof rules.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Cooldown = typeof cooldowns.$inferSelect;
