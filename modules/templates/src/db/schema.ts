import { guildTable } from '@bronto/core/tables';
import type { APIEmbed } from 'discord.js';
import { boolean, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const templatesSchema = pgSchema('templates');

export const IMAGE_SLOTS = ['image', 'thumbnail', 'author_icon', 'footer_icon'] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

/** The server's template forum; the unique guild_id index keeps it to one row per server. */
export const forums = guildTable(
  templatesSchema,
  'forums',
  {
    forumChannelId: text('forum_channel_id').primaryKey(),
  },
  (t) => [uniqueIndex('forums_guild_id_key').on(t.guildId)],
);

/** A template; exists only together with its forum post. created_at and updated_at are audit columns. */
export const templates = guildTable(templatesSchema, 'templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  /** Uploaded images are referenced in `templateImages`; hand-typed URLs stay here as they are. */
  embed: jsonb('embed').$type<APIEmbed>(),
  showPostTime: boolean('show_post_time').notNull().default(false),
  threadId: text('thread_id').notNull().unique(),
  previewMessageId: text('preview_message_id').notNull(),
});

/** Uploaded images: attachments on the preview message, with the last signed link and its expiry. */
export const templateImages = guildTable(
  templatesSchema,
  'template_images',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    /** One of `IMAGE_SLOTS`; checked in code. */
    slot: text('slot').$type<ImageSlot>().notNull(),
    messageId: text('message_id').notNull(),
    attachmentId: text('attachment_id').notNull(),
    url: text('url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.slot] })],
);

export type Template = typeof templates.$inferSelect;
export type TemplateImage = typeof templateImages.$inferSelect;
