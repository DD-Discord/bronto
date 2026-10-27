import { downloadFile } from '@bronto/core';
import { ChannelType, DiscordAPIError, RESTJSONErrorCodes, type ThreadChannel } from 'discord.js';
import { and, eq, lt, notExists, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { FormsContext } from './context.js';
import { drafts, forums, submissions, type Draft, type DraftFile, type Form } from './db/schema.js';
import { channelExists } from './forum.js';

/** How long unfinished answers are kept after the last saved page. */
export const DRAFT_TTL_MS = 86_400_000;
/** How often expired drafts are deleted. */
export const DRAFT_SWEEP_MS = 3_600_000;

const DRAFTS_THREAD = 'drafts';
/** Discord's limit on attachments per message. */
const FILES_PER_MESSAGE = 10;

export const isExpired = (draft: Pick<Draft, 'expiresAt'>, now = Date.now()) => draft.expiresAt.getTime() <= now;

/** The member's draft of the form, expired or not. */
export async function loadDraft(ctx: FormsContext, formId: string, userId: string, dry: boolean): Promise<Draft | null> {
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, dry))),
  );
  return row ?? null;
}

async function storedThreadId(ctx: FormsContext): Promise<string | null> {
  const [row] = await ctx.db.run(async (tx) => tx.select({ id: forums.draftsThreadId }).from(forums));
  return row?.id ?? null;
}

/** Creates the drafts post unless the stored one exists. Runs queued, so that concurrent uploads create one post. */
async function ensureDraftsThread(ctx: FormsContext): Promise<void> {
  const [row] = await ctx.db.run(async (tx) => tx.select().from(forums));
  if (row === undefined) throw new Error('The server has no forms forum for draft files.');
  if (row.draftsThreadId !== null && (await channelExists(ctx, row.draftsThreadId))) return;
  const forum = await ctx.client.channels.fetch(row.forumChannelId);
  if (forum?.type !== ChannelType.GuildForum) throw new Error(`Forms forum ${row.forumChannelId} is not a forum channel.`);
  const thread = await forum.threads.create({
    name: DRAFTS_THREAD,
    message: { content: 'Files members upload while filling in forms. Unfinished answers are deleted after a day.', allowedMentions: { parse: [] } },
  });
  await thread.setLocked(true);
  await ctx.db.run(async (tx) => {
    await tx.update(forums).set({ draftsThreadId: thread.id }).where(eq(forums.forumChannelId, row.forumChannelId));
  });
}

/** The drafts post, created as a locked post of the forms forum on first use. */
async function draftsThread(ctx: FormsContext): Promise<ThreadChannel> {
  // A replaced queued task still ends with the post in place: the task that replaced it created it.
  await ctx.queue.run('drafts-thread', (task) => ensureDraftsThread(task as FormsContext));
  const id = await storedThreadId(ctx);
  const thread = id === null ? null : await ctx.client.channels.fetch(id);
  if (thread === null || !thread.isThread()) throw new Error('The drafts post could not be created.');
  return thread;
}

/** The stored drafts post, or null when it is gone. */
async function existingThread(ctx: FormsContext): Promise<ThreadChannel | null> {
  const id = await storedThreadId(ctx);
  if (id === null) return null;
  try {
    const thread = await ctx.client.channels.fetch(id);
    return thread?.isThread() === true ? thread : null;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return null;
    throw error;
  }
}

export interface NewFile {
  fieldId: string;
  name: string;
  size: number;
  contentType: string | null;
  data: Buffer;
}

/** Groups files into messages of at most ten files and `limit` bytes. */
function batches(files: NewFile[], limit: number): NewFile[][] {
  const result: NewFile[][] = [];
  let current: NewFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= FILES_PER_MESSAGE || bytes + file.size > limit)) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

async function sendToThread(thread: ThreadChannel, files: NewFile[]) {
  const options = { files: files.map((file) => ({ attachment: file.data, name: file.name })), allowedMentions: { parse: [] } };
  try {
    return await thread.send(options);
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread)) throw error;
    await thread.setArchived(false);
    return thread.send(options);
  }
}

/** Uploads a page's files to the drafts post, in as few messages as Discord allows. */
export async function storeFiles(ctx: FormsContext, files: NewFile[], limit: number): Promise<DraftFile[]> {
  if (files.length === 0) return [];
  const thread = await draftsThread(ctx);
  const stored: DraftFile[] = [];
  try {
    for (const batch of batches(files, limit)) {
      const message = await sendToThread(thread, batch);
      const attachments = [...message.attachments.values()];
      batch.forEach((file, index) => {
        const attachment = attachments[index];
        if (attachment === undefined) throw new Error('Discord dropped an uploaded draft file.');
        stored.push({
          key: randomBytes(6).toString('base64url'),
          fieldId: file.fieldId,
          messageId: message.id,
          attachmentId: attachment.id,
          name: file.name,
          size: file.size,
          contentType: file.contentType,
        });
      });
    }
  } catch (error) {
    await releaseFiles(ctx, stored, []);
    throw error;
  }
  return stored;
}

/**
 * Removes `removed` files from the drafts post: a message whose files are all gone is deleted, one that still carries
 * `kept` files is edited down to them. Failures are logged; the files only take up room.
 */
export async function releaseFiles(ctx: FormsContext, removed: DraftFile[], kept: DraftFile[]): Promise<void> {
  if (removed.length === 0) return;
  let thread: ThreadChannel | null;
  try {
    thread = await existingThread(ctx);
  } catch (error) {
    ctx.log.warn({ err: error }, 'Finding the drafts post failed');
    return;
  }
  if (thread === null) return;
  for (const messageId of new Set(removed.map((file) => file.messageId))) {
    const keep = kept.filter((file) => file.messageId === messageId);
    try {
      if (keep.length === 0) await thread.messages.delete(messageId);
      else await thread.messages.edit(messageId, { attachments: keep.map((file) => ({ id: file.attachmentId }) as never) });
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) continue;
      ctx.log.warn({ err: error, messageId }, 'Removing draft files failed');
    }
  }
}

/** A draft file that is no longer on Discord. */
export class MissingFileError extends Error {
  constructor(readonly file: DraftFile) {
    super(`The draft file ${file.name} is gone.`);
  }
}

/** Downloads draft files of at most `limit` bytes each; their messages are refetched for fresh links. */
export async function downloadFiles(ctx: FormsContext, files: DraftFile[], limit: number): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  if (files.length === 0) return result;
  const thread = await existingThread(ctx);
  const links = new Map<string, string>();
  for (const messageId of new Set(files.map((file) => file.messageId))) {
    if (thread === null) break;
    try {
      const message = await thread.messages.fetch({ message: messageId, force: true });
      for (const attachment of message.attachments.values()) links.set(attachment.id, attachment.url);
    } catch (error) {
      if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage)) throw error;
    }
  }
  for (const file of files) {
    const url = links.get(file.attachmentId);
    if (url === undefined) throw new MissingFileError(file);
    result.set(file.key, await downloadFile(url, limit));
  }
  return result;
}

/** Deletes the member's draft and its files. */
export async function deleteDraft(ctx: FormsContext, formId: string, userId: string, dry: boolean): Promise<void> {
  const gone = await ctx.db.run(async (tx) =>
    tx
      .delete(drafts)
      .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, dry)))
      .returning(),
  );
  await releaseFiles(ctx, gone.flatMap((draft) => draft.files), []);
}

/** Deletes expired drafts and their files. A draft whose submission is still being posted stays for Try again. */
export async function sweepDrafts(ctx: FormsContext): Promise<void> {
  const gone = await ctx.db.run(async (tx) => {
    const posting = tx
      .select({ one: sql`1` })
      .from(submissions)
      .where(and(eq(submissions.formId, drafts.formId), eq(submissions.userId, drafts.userId), eq(submissions.status, 'posting')));
    return tx
      .delete(drafts)
      .where(and(lt(drafts.expiresAt, new Date()), or(eq(drafts.dry, true), notExists(posting))))
      .returning();
  });
  await releaseFiles(ctx, gone.flatMap((draft) => draft.files), []);
}

/** Drops the draft files of fields the form no longer has as file fields. */
export async function pruneDraftFiles(ctx: FormsContext, form: Pick<Form, 'id' | 'fields'>): Promise<void> {
  const fileFields = new Set(form.fields.filter((field) => field.type === 'file').map((field) => field.id));
  const changes = await ctx.db.run(async (tx) => {
    const rows = await tx.select().from(drafts).where(eq(drafts.formId, form.id)).for('update');
    const result: { removed: DraftFile[]; kept: DraftFile[] }[] = [];
    for (const row of rows) {
      const kept = row.files.filter((file) => fileFields.has(file.fieldId));
      if (kept.length === row.files.length) continue;
      const removed = row.files.filter((file) => !fileFields.has(file.fieldId));
      const answers = Object.fromEntries(Object.entries(row.answers).filter(([id, answer]) => !('files' in answer) || fileFields.has(id)));
      await tx
        .update(drafts)
        .set({ files: kept, answers })
        .where(and(eq(drafts.formId, row.formId), eq(drafts.userId, row.userId), eq(drafts.dry, row.dry)));
      result.push({ removed, kept });
    }
    return result;
  });
  for (const { removed, kept } of changes) await releaseFiles(ctx, removed, kept);
}
