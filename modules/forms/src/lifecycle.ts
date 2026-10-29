import { defineManagedForum, UserError } from '@bronto/core';
import { ChannelType, MessageFlags, TextDisplayBuilder, type AnyThreadChannel } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { drafts, forms, forums, openers, type Form } from './db/schema.js';
import { releaseFiles } from './drafts.js';
import { formsEvents } from './events.js';
import { formName } from './model.js';
import { cleanupOpeners } from './openers.js';
import { updatePreview } from './preview.js';

type Gone = Pick<Form, 'id' | 'name' | 'threadId'>;

/**
 * Deletes the form's row under a lock (its drafts and submissions go with it), logs it and emits `deleted`, then
 * removes its opener messages, sticky buttons and draft files from Discord. False when the form was already gone. With
 * `refuseWithOpeners`, a form that has openers is kept and the channels of its openers are returned instead.
 */
export async function forgetForm(ctx: FormsContext, form: Gone, options: { refuseWithOpeners?: boolean } = {}): Promise<boolean | { blockedBy: string[] }> {
  const removed = await ctx.db.run(async (tx) => {
    const [row] = await tx.select().from(forms).where(eq(forms.id, form.id)).for('update');
    if (row === undefined) return null;
    if (options.refuseWithOpeners === true) {
      const held = await tx.select({ channelId: openers.channelId }).from(openers).where(eq(openers.formId, form.id));
      if (held.length > 0) return { blocked: [...new Set(held.map((opener) => opener.channelId))].sort(), row, gone: [] };
    }
    const gone = await tx.delete(openers).where(eq(openers.formId, form.id)).returning();
    const files = (await tx.select({ files: drafts.files }).from(drafts).where(eq(drafts.formId, form.id))).flatMap((draft) => draft.files);
    await tx.delete(forms).where(eq(forms.id, form.id));
    return { row, gone, files, blocked: undefined };
  });
  if (removed === null) return false;
  if (removed.blocked !== undefined) return { blockedBy: removed.blocked };
  const { id, name, threadId } = removed.row;
  ctx.log.info({ formId: id, name, threadId }, 'Form deleted');
  ctx.emit(formsEvents.deleted, { id });
  await cleanupOpeners(ctx, removed.gone);
  await releaseFiles(ctx, removed.files, []);
  return true;
}

/** A renamed post renames its form, cut to `MAX_NAME`, and redraws its preview. */
async function renameForm(ctx: FormsContext, thread: AnyThreadChannel): Promise<void> {
  const name = formName(thread.name);
  if (name === '') return;
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .update(forms)
      .set({ name })
      .where(and(eq(forms.threadId, thread.id), ne(forms.name, name)))
      .returning(),
  );
  if (row === undefined) return;
  try {
    await updatePreview(ctx, row);
  } catch (error) {
    ctx.log.warn({ err: error, formId: row.id, threadId: thread.id }, 'Updating the preview of a renamed form failed');
  }
}

/**
 * The forms forum. A deleted post deletes its form through `forgetForm`; a deleted forum deletes every form and its
 * openers, which are then removed from Discord.
 */
export const formForum = defineManagedForum({
  forumName: 'forms',
  tables: { forums, records: forms },
  wording: { noun: 'form', forumLabel: 'forms forum', logKey: 'formId' },
  createFromPost: (ctx, thread) => createFormPost(ctx, { name: thread.name, tags: thread.appliedTags }),
  forgetOne: (ctx, record) => forgetForm(ctx, record),
  forgetAllTx: (tx) => tx.delete(openers).returning(),
  forgotAll: async (ctx, records, removedOpeners) => {
    for (const { id } of records) ctx.emit(formsEvents.deleted, { id });
    await cleanupOpeners(ctx, removedOpeners);
  },
  rename: (ctx, thread) => renameForm(ctx, thread),
});

/**
 * Creates a form: its post in the forms forum first, then the row, then the preview. The buttons are signed for the
 * thread, so the starter message is a placeholder until the thread exists. If anything fails, the post is deleted.
 */
export async function createFormPost(ctx: FormsContext, input: { name: string; tags?: string[] }): Promise<Form> {
  const name = formName(input.name);
  if (name === '') throw new UserError('A form needs a name.');
  const forumId = await formForum.ensure(ctx);
  const forum = await ctx.client.channels.fetch(forumId);
  if (forum?.type !== ChannelType.GuildForum) throw new Error(`Forms forum ${forumId} is not a forum channel.`);
  const thread = await forum.threads.create({
    name,
    appliedTags: input.tags,
    message: {
      components: [new TextDisplayBuilder().setContent(`Setting up **${name}**…`)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    },
  });
  try {
    // The starter message has the thread's ID.
    const [row] = await ctx.db.run(async (tx) =>
      tx.insert(forms).values({ name, threadId: thread.id, previewMessageId: thread.id }).returning(),
    );
    await updatePreview(ctx, row!);
    return row!;
  } catch (error) {
    await ctx.db.run(async (tx) => {
      await tx.delete(forms).where(eq(forms.threadId, thread.id));
    });
    try {
      await thread.delete();
    } catch (deleteError) {
      ctx.log.warn({ err: deleteError, threadId: thread.id }, 'Deleting the post of a form that failed to save failed');
    }
    throw error;
  }
}
