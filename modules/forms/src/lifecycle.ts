import type { AnyThreadChannel, Channel, PartialDMChannel } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { forms, forums, type Form } from './db/schema.js';
import { channelExists, storedForumId } from './forum.js';

type Gone = Pick<Form, 'id' | 'name' | 'threadId'>;

function announce(ctx: FormsContext, gone: Gone[]): void {
  for (const { id, name, threadId } of gone) ctx.log.info({ formId: id, name, threadId }, 'Form deleted');
}

/** Deletes the form's row (its openers, drafts and submissions go with it) and logs it; false when it was already gone. */
export async function forgetForm(ctx: FormsContext, form: Gone): Promise<boolean> {
  const rows = await ctx.db.run(async (tx) => tx.delete(forms).where(eq(forms.id, form.id)).returning());
  announce(ctx, rows);
  return rows.length > 0;
}

/**
 * Deletes every form and the forum row. Does nothing once another forum is stored: `init` may have replaced the gone
 * forum while it was being checked.
 */
async function forgetForum(ctx: FormsContext, forumId: string): Promise<void> {
  const rows = await ctx.db.run(async (tx) => {
    const [stored] = await tx.select({ id: forums.forumChannelId }).from(forums).for('update');
    if (stored?.id !== forumId) return [];
    const deleted = await tx.delete(forms).returning();
    await tx.delete(forums);
    return deleted;
  });
  announce(ctx, rows);
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

/** A renamed post renames its form. */
export async function onThreadUpdate(ctx: FormsContext, _old: AnyThreadChannel, thread: AnyThreadChannel): Promise<void> {
  await ctx.db.run(async (tx) => {
    await tx
      .update(forms)
      .set({ name: thread.name })
      .where(and(eq(forms.threadId, thread.id), ne(forms.name, thread.name)));
  });
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
