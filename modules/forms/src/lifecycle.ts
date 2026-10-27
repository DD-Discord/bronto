import type { AnyThreadChannel, Channel, PartialDMChannel } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { drafts, forms, forums, openers, type Form } from './db/schema.js';
import { releaseFiles } from './drafts.js';
import { channelExists, storedForumId } from './forum.js';
import { formName } from './model.js';
import { cleanupOpeners } from './openers.js';
import { updatePreview } from './preview.js';

type Gone = Pick<Form, 'id' | 'name' | 'threadId'>;

function announce(ctx: FormsContext, gone: Gone[]): void {
  for (const { id, name, threadId } of gone) ctx.log.info({ formId: id, name, threadId }, 'Form deleted');
}

/**
 * Deletes the form's row under a lock (its drafts and submissions go with it) and logs it, then removes its opener
 * messages, sticky buttons and draft files from Discord. False when the form was already gone. With
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
  announce(ctx, [removed.row]);
  await cleanupOpeners(ctx, removed.gone);
  await releaseFiles(ctx, removed.files, []);
  return true;
}

/**
 * Deletes every form and the forum row. Does nothing once another forum is stored: `init` may have replaced the gone
 * forum while it was being checked.
 */
async function forgetForum(ctx: FormsContext, forumId: string): Promise<void> {
  const removed = await ctx.db.run(async (tx) => {
    const [stored] = await tx.select({ id: forums.forumChannelId }).from(forums).for('update');
    if (stored?.id !== forumId) return null;
    const gone = await tx.delete(openers).returning();
    const deleted = await tx.delete(forms).returning();
    await tx.delete(forums);
    return { deleted, gone };
  });
  if (removed === null) return;
  announce(ctx, removed.deleted);
  await cleanupOpeners(ctx, removed.gone);
}

/** A post deleted in Discord deletes its form. */
export async function onThreadDelete(ctx: FormsContext, data: { id: string }): Promise<void> {
  const [row] = await ctx.db.run(async (tx) => tx.select().from(forms).where(eq(forms.threadId, data.id)));
  if (row !== undefined) await forgetForm(ctx, row);
}

/** The forms forum deleted in Discord deletes all its forms. */
export async function onChannelDelete(ctx: FormsContext, channel: Channel | PartialDMChannel): Promise<void> {
  await forgetForum(ctx, channel.id);
}

/** A renamed post renames its form, cut to `MAX_NAME`, and redraws its preview. */
export async function onThreadUpdate(ctx: FormsContext, _old: AnyThreadChannel, thread: AnyThreadChannel): Promise<void> {
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
 * Drops forms whose forum or post was deleted while the bot was away. Only Unknown Channel counts as gone; any other
 * failure (permissions, outages) keeps the data and logs a warning.
 */
export async function reconcile(ctx: FormsContext): Promise<void> {
  const forumId = await storedForumId(ctx);
  if (forumId !== null) {
    let exists: boolean;
    try {
      exists = await channelExists(ctx, forumId);
    } catch (error) {
      ctx.log.warn({ err: error, channelId: forumId }, 'Checking the forms forum failed');
      return;
    }
    if (!exists) {
      await forgetForum(ctx, forumId);
      return;
    }
  }
  const rows = await ctx.db.run(async (tx) => tx.select().from(forms));
  for (const row of rows) {
    let exists: boolean;
    try {
      exists = await channelExists(ctx, row.threadId);
    } catch (error) {
      ctx.log.warn({ err: error, formId: row.id, threadId: row.threadId }, 'Checking a form post failed');
      continue;
    }
    if (!exists) await forgetForm(ctx, row);
  }
}
