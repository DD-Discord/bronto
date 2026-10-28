import { guildTable } from '@bronto/core/tables';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Field } from '../model.js';
import type { RenderedPart } from '../render.js';

export const formsSchema = pgSchema('forms');

/** A member's answer to one field; file answers hold draft-file keys. */
export type Answer = { text: string } | { choices: string[] } | { files: string[] };

/** A file a member attached while filling in a form: an attachment on a bot-posted message. */
export type DraftFile = {
  key: string;
  fieldId: string;
  messageId: string;
  attachmentId: string;
  name: string;
  size: number;
  contentType: string | null;
};

/** A file of a submission; `messageId` is the submission part that carries it. */
export type SubmissionFile = DraftFile;

/** The server's forms forum; the unique guild_id index keeps it to one row per server. */
export const forums = guildTable(
  formsSchema,
  'forums',
  {
    forumChannelId: text('forum_channel_id').primaryKey(),
    /** The thread that carries drafts' uploaded files; created on first use. */
    draftsThreadId: text('drafts_thread_id'),
  },
  (t) => [uniqueIndex('forums_guild_id_key').on(t.guildId)],
);

/** A form; exists only together with its forum post. */
export const forms = guildTable(formsSchema, 'forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: text('thread_id').notNull().unique(),
  previewMessageId: text('preview_message_id').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(false),
  channelId: text('channel_id'),
  pingUserIds: text('ping_user_ids').array().notNull().default([]),
  pingRoleIds: text('ping_role_ids').array().notNull().default([]),
  allowedRoleIds: text('allowed_role_ids').array().notNull().default([]),
  oncePerMember: boolean('once_per_member').notNull().default(true),
  /** Posts the answers in their own message, after the details. */
  answersApart: boolean('answers_apart').notNull().default(false),
  fields: jsonb('fields').$type<Field[]>().notNull().default([]),
  /** IDs of fields deleted from the form; their answers stay in old submissions. */
  removedFieldIds: text('removed_field_ids').array().notNull().default([]),
});

/** A message that opens the form: a button on `messageId`, or on the channel's sticky when it is null. */
export const openers = guildTable(
  formsSchema,
  'openers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    templateId: uuid('template_id'),
    label: text('label').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('openers_form_id_idx').on(t.formId)],
);

/** A member's unfinished answers; `dry` marks a moderator's trial run, which never mixes with a real draft. */
export const drafts = guildTable(
  formsSchema,
  'drafts',
  {
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    dry: boolean('dry').notNull().default(false),
    /** Index of the next page to fill in. */
    page: integer('page').notNull().default(0),
    answers: jsonb('answers').$type<Record<string, Answer>>().notNull().default({}),
    files: jsonb('files').$type<DraftFile[]>().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.formId, t.userId, t.dry] })],
);

/**
 * What a submission posts, fixed when it is submitted so that every attempt posts the same parts: the fields as they
 * were, the rendered parts, and the names of uploaded files that weren't posted (their field was removed, or the file
 * was gone).
 */
export interface SubmissionRender {
  fields: Field[];
  parts: RenderedPart[];
  dropped: { name: string; reason: 'removed' | 'missing' }[];
}

/** A finished submission. */
export const submissions = guildTable(
  formsSchema,
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    answers: jsonb('answers').$type<Record<string, Answer>>().notNull(),
    files: jsonb('files').$type<SubmissionFile[]>().notNull().default([]),
    channelId: text('channel_id').notNull(),
    status: text('status').$type<'posting' | 'posted'>().notNull(),
    partMessageIds: text('part_message_ids').array().notNull().default([]),
    /** The channel or thread that the parts after the first go to; null until part 2 is posted. */
    restChannelId: text('rest_channel_id'),
    render: jsonb('render').$type<SubmissionRender>().notNull(),
    /** Copied from the form at submit time: the unique index lets such a member submit once. */
    once: boolean('once').notNull(),
  },
  (t) => [uniqueIndex('submissions_once_key').on(t.formId, t.userId).where(sql`${t.once}`)],
);

export type Form = typeof forms.$inferSelect;
export type Opener = typeof openers.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
