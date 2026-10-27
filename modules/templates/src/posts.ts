import { linkExpiry, UserError } from '@bronto/core';
import { ChannelType, DiscordAPIError, RESTJSONErrorCodes, type Message, type MessageEditOptions } from 'discord.js';
import { eq } from 'drizzle-orm';
import { normalizeEmbed, validateTemplate, type TemplateMessage } from './content.js';
import type { TemplatesContext } from './context.js';
import { templateImages, templates, type ImageSlot, type Template } from './db/schema.js';
import { ensureForum } from './forum.js';
import { messageAttachments } from './images.js';
import { previewBody, previewButtonRow, previewMessage, uploadFileName, withUploads, type PendingUpload } from './preview.js';

export type { PendingUpload } from './preview.js';

// Discord's limit for thread names.
const MAX_TITLE = 100;

export type NewTemplate = { id?: string; name: string; tags?: string[] } & TemplateMessage & { uploads?: PendingUpload[] };

/** The name cut to a post title's length, without leaving half of a surrogate pair. */
function postTitle(name: string): string {
  const title = name.trim().slice(0, MAX_TITLE);
  return /[\uD800-\uDBFF]$/.test(title) ? title.slice(0, -1) : title;
}

/** The template_images values of the uploads, from the attachments the preview message carries. */
function imageValues(message: Message, uploads: PendingUpload[]) {
  return uploads.map((upload) => {
    const name = uploadFileName(upload);
    const attachment = messageAttachments(message).find((entry) => entry.name === name);
    if (attachment === undefined) throw new Error(`The preview message has no attachment named ${name}.`);
    // A link without a readable expiry is stored as already due, so the next render refetches it.
    const expiresAt = linkExpiry(attachment.url) ?? new Date();
    return { slot: upload.slot, messageId: message.id, attachmentId: attachment.id, url: attachment.url, expiresAt };
  });
}

const ICON_OWNER: Partial<Record<ImageSlot, string>> = {
  author_icon: 'An author icon needs an author name.',
  footer_icon: 'A footer icon needs footer text.',
};

/**
 * Creates a template: its post in the template forum first (the forum is created when there is none), then the row
 * and image rows in one transaction. If storing fails, the post is deleted again.
 */
export async function createPost(ctx: TemplatesContext, input: NewTemplate): Promise<Template> {
  const uploads = input.uploads ?? [];
  const name = postTitle(input.name);
  if (name === '') throw new UserError('A template needs a name.');
  const placed = withUploads(input.embed, uploads);
  const [unplaced] = placed.unplaced;
  if (unplaced !== undefined) throw new UserError(ICON_OWNER[unplaced]!);
  const message: TemplateMessage = { content: input.content, embed: placed.embed === null ? null : normalizeEmbed(placed.embed) };
  const problem = validateTemplate(message);
  if (problem !== null) throw new UserError(problem);

  const forumId = await ensureForum(ctx);
  const forum = await ctx.client.channels.fetch(forumId);
  if (forum?.type !== ChannelType.GuildForum) throw new Error(`Template forum ${forumId} is not a forum channel.`);
  const thread = await forum.threads.create({ name, appliedTags: input.tags, message: previewBody(message, uploads) });
  try {
    // The buttons are signed for the thread, so they're added once it exists. The starter message has the thread's ID.
    const preview = await thread.messages.edit(thread.id, { components: [previewButtonRow(ctx, thread.id)] });
    const images = imageValues(preview, uploads);
    return await ctx.db.run(async (tx) => {
      const [row] = await tx
        .insert(templates)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          name,
          ...message,
          threadId: thread.id,
          previewMessageId: preview.id,
        })
        .returning();
      if (images.length > 0) await tx.insert(templateImages).values(images.map((image) => ({ ...image, templateId: row!.id })));
      return row!;
    });
  } catch (error) {
    try {
      await thread.delete();
    } catch (deleteError) {
      ctx.log.warn({ err: deleteError, threadId: thread.id }, 'Deleting the post of a template that failed to save failed');
    }
    throw error;
  }
}

/**
 * Edits the post's starter message to show the template. Uploads replace the attachments of their slots, the others
 * stay unless `syncAttachments` is set: then exactly the stored image rows stay attached, so images whose rows were
 * deleted are dropped from the message. An archived post is unarchived and the edit retried once; the bot owns the post, so this works when it is
 * locked too.
 */
export async function updatePreview(
  ctx: TemplatesContext,
  template: Template,
  uploads: PendingUpload[] = [],
  { syncAttachments = false }: { syncAttachments?: boolean } = {},
): Promise<void> {
  const replaced = new Set(uploads.map((upload) => upload.slot));
  const stored =
    uploads.length === 0 && !syncAttachments
      ? []
      : await ctx.db.run(async (tx) =>
          tx
            .select({ slot: templateImages.slot, attachmentId: templateImages.attachmentId })
            .from(templateImages)
            .where(eq(templateImages.templateId, template.id)),
        );
  const kept = stored.filter((image) => !replaced.has(image.slot));
  // Built per attempt: discord.js appends the new files to the `attachments` list it is given.
  const options = (): MessageEditOptions => ({
    ...previewMessage(ctx, template, uploads),
    ...(uploads.length === 0 && !syncAttachments ? {} : { attachments: kept.map((image) => ({ id: image.attachmentId })) }),
  });

  const thread = await ctx.client.channels.fetch(template.threadId);
  if (thread === null || !thread.isThread()) throw new Error(`Template post ${template.threadId} is not a thread.`);
  let message: Message;
  try {
    message = await thread.messages.edit(template.previewMessageId, options());
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread)) throw error;
    await thread.setArchived(false);
    message = await thread.messages.edit(template.previewMessageId, options());
  }

  if (uploads.length === 0) return;
  const images = imageValues(message, uploads);
  await ctx.db.run(async (tx) => {
    for (const image of images) {
      await tx
        .insert(templateImages)
        .values({ ...image, templateId: template.id })
        .onConflictDoUpdate({
          target: [templateImages.templateId, templateImages.slot],
          set: { messageId: image.messageId, attachmentId: image.attachmentId, url: image.url, expiresAt: image.expiresAt },
        });
    }
  });
}
