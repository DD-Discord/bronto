import { UserError } from '@bronto/core';
import {
  ChannelType,
  MessageFlags,
  TextDisplayBuilder,
  type AnyThreadChannel,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { forms, type Form } from './db/schema.js';
import { ensureForum, storedForumId } from './forum.js';
import { formName } from './model.js';
import { updatePreview } from './preview.js';

/**
 * Creates a form: its post in the forms forum first, then the row, then the preview. The buttons are signed for the
 * thread, so the starter message is a placeholder until the thread exists. If anything fails, the post is deleted.
 */
export async function createFormPost(ctx: FormsContext, input: { name: string; tags?: string[] }): Promise<Form> {
  const name = formName(input.name);
  if (name === '') throw new UserError('A form needs a name.');
  const forumId = await ensureForum(ctx);
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

async function reply(ctx: FormsContext, thread: AnyThreadChannel, text: string): Promise<void> {
  try {
    await thread.send({ content: text, allowedMentions: { parse: [] } });
  } catch (error) {
    ctx.log.warn({ err: error, threadId: thread.id }, 'Replying in a forum post failed');
  }
}

/**
 * Turns a new post in the forms forum into a form owned by the bot, named after the post (cut to `MAX_NAME`), and
 * deletes the member's post. Problems are answered in the post, which stays.
 */
export async function onThreadCreate(ctx: FormsContext, thread: AnyThreadChannel, newlyCreated: boolean): Promise<void> {
  if (!newlyCreated || thread.ownerId === ctx.client.user?.id) return;
  const forumId = await storedForumId(ctx);
  if (forumId === null || thread.parentId !== forumId) return;
  try {
    await createFormPost(ctx, { name: thread.name, tags: thread.appliedTags });
  } catch (error) {
    const reason = error instanceof UserError ? error.message : 'Something went wrong.';
    await reply(ctx, thread, `I couldn't turn this post into a form: ${reason}`);
    if (!(error instanceof UserError)) throw error;
    return;
  }
  try {
    await thread.delete();
  } catch (error) {
    ctx.log.warn({ err: error, threadId: thread.id }, "Deleting the member's post after creating its form failed");
  }
}
