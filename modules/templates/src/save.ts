import { downloadFile, UserError, type ButtonContext, type ModalContext } from '@bronto/core';
import { DiscordAPIError } from 'discord.js';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeEmbed, validateTemplate, type TemplateMessage } from './content.js';
import type { TemplatesContext } from './context.js';
import { IMAGE_SLOTS, templateImages, templates, type ImageSlot, type Template, type TemplateImage } from './db/schema.js';
import { editorView } from './editor.js';
import { templatesEvents } from './events.js';
import { updatePreview } from './posts.js';
import { uploadFileName, type PendingUpload } from './preview.js';
import { slotUrl } from './render.js';
import { applySection } from './apply.js';
import { draftOf, TryAgainError, type SectionChange } from './sections.js';

const UPLOAD_PREFIX = 'attachment://';

/** A stored change: the template as saved, its image rows, and why the post couldn't be updated (null if it was). */
export interface Stored {
  template: Template;
  images: TemplateImage[];
  failure: string | null;
}

/** The next content and embed, and the time-of-posting setting when the change sets it. */
export type NextMessage = TemplateMessage & { showPostTime?: boolean };

/** The part of an error a user may see. */
function failureReason(error: unknown): string {
  return error instanceof UserError || error instanceof DiscordAPIError ? error.message : 'something went wrong, the error was logged';
}

/**
 * Saves a change to the template of `threadId` in one transaction: the row is read `FOR UPDATE`, `apply` turns it and
 * its image rows into the next state, which is normalized, validated (problems are thrown as `refuse(message)`) and
 * written; image rows the embed no longer references are deleted. Then the preview is redrawn, `uploads` attached,
 * and `updated` fires, also when the preview couldn't be updated.
 */
export async function storeTemplate(
  ctx: TemplatesContext,
  threadId: string,
  apply: (current: Template, images: TemplateImage[]) => NextMessage,
  options: { uploads?: PendingUpload[]; refuse?: (message: string) => UserError } = {},
): Promise<Stored> {
  const uploads = options.uploads ?? [];
  const refuse = options.refuse ?? ((message: string) => new UserError(message));
  const template = await ctx.db.run(async (tx) => {
    const [current] = await tx.select().from(templates).where(eq(templates.threadId, threadId)).for('update');
    if (current === undefined) throw new UserError('This template no longer exists.');
    const images = await tx.select().from(templateImages).where(eq(templateImages.templateId, current.id));
    const next = apply(current, images);
    const embed = next.embed === null ? null : normalizeEmbed(next.embed);
    const problem = validateTemplate({ content: next.content, embed });
    if (problem !== null) throw refuse(problem);

    const [row] = await tx
      .update(templates)
      .set({ content: next.content, embed, ...(next.showPostTime === undefined ? {} : { showPostTime: next.showPostTime }) })
      .where(eq(templates.id, current.id))
      .returning();
    // A slot that gets a new upload loses its old row too, so render never shows the old image for the new name.
    const replaced = new Set(uploads.map((upload) => upload.slot));
    const removed = IMAGE_SLOTS.filter((slot) => replaced.has(slot) || slotUrl(embed ?? {}, slot)?.startsWith(UPLOAD_PREFIX) !== true);
    await tx.delete(templateImages).where(and(eq(templateImages.templateId, current.id), inArray(templateImages.slot, removed)));
    return row!;
  });

  const error = await refreshPreview(ctx, template.id, uploads);
  ctx.emit(templatesEvents.updated, { id: template.id });
  const images = await ctx.db.run(async (tx) => tx.select().from(templateImages).where(eq(templateImages.templateId, template.id)));
  return { template, images, failure: error === null ? null : failureReason(error) };
}

/** Uploads waiting for the next preview redraw of a template; the redraw that starts takes them all. */
interface Batch {
  guildId: string;
  uploads: Map<ImageSlot, PendingUpload>;
  started: boolean;
  error: unknown;
}

// Module-level, so shared by every instance of the module in the process, like the components that use it.
const waiting = new Map<string, Batch>();

/** The template's waiting batch, created when there is none. */
function waitingBatch(guildId: string, templateId: string): Batch {
  let batch = waiting.get(templateId);
  if (batch === undefined) {
    batch = { guildId, uploads: new Map(), started: false, error: null };
    waiting.set(templateId, batch);
  }
  return batch;
}

/** Puts uploads of a failed redraw back for the next one; a newer upload for the same slot wins. */
function putBack(guildId: string, templateId: string, uploads: Iterable<PendingUpload>): void {
  const batch = waitingBatch(guildId, templateId);
  for (const upload of uploads) if (!batch.uploads.has(upload.slot)) batch.uploads.set(upload.slot, upload);
}

/** Drops the uploads waiting for a redraw in the guild; for `guildStopped`. */
export function dropWaitingUploads(guildId: string): void {
  for (const [templateId, batch] of waiting) if (batch.guildId === guildId) waiting.delete(templateId);
}

/**
 * Redraws the preview from the stored template in the template's queue: a burst of saves collapses into one redraw
 * that reads the latest row. Uploads ride along in a batch that the next starting redraw takes, so a replaced queue
 * task never drops one, and redraws never overlap. When the redraw fails or doesn't run, its uploads wait for the next
 * save's redraw. Resolves with the redraw's error, or null.
 */
export async function refreshPreview(ctx: TemplatesContext, templateId: string, uploads: PendingUpload[] = []): Promise<unknown> {
  const mine = waitingBatch(ctx.guildId, templateId);
  for (const upload of uploads) mine.uploads.set(upload.slot, upload);
  await ctx.queue.run(templateId, async (task) => {
    const taken = waiting.get(templateId);
    if (taken === undefined) return;
    waiting.delete(templateId);
    taken.started = true;
    try {
      await redraw(task as TemplatesContext, templateId, [...taken.uploads.values()]);
    } catch (error) {
      taken.error = error;
      putBack(taken.guildId, templateId, taken.uploads.values());
      task.log.warn({ err: error, templateId }, 'Updating the post of a template failed');
    }
  });
  if (mine.started) return mine.error;
  // The queue skipped the redraw (the bot is stopping or the module was switched off); the batch stays waiting.
  return new UserError("the update didn't run.");
}

/** Edits the preview to show the stored template; uploads are attached when their slot still points at them. */
async function redraw(ctx: TemplatesContext, templateId: string, uploads: PendingUpload[]): Promise<void> {
  const [template] = await ctx.db.run(async (tx) => tx.select().from(templates).where(eq(templates.id, templateId)));
  if (template === undefined) return;
  const placed = uploads.filter((upload) => slotUrl(template.embed ?? {}, upload.slot) === `${UPLOAD_PREFIX}${uploadFileName(upload)}`);
  await updatePreview(ctx, template, placed, { syncAttachments: true });
}

async function download(
  ctx: TemplatesContext,
  change: Extract<SectionChange, { files: unknown }>,
  refuse: (message: string) => UserError,
): Promise<PendingUpload[]> {
  const uploads: PendingUpload[] = [];
  for (const slot of IMAGE_SLOTS) {
    const file = change.files[slot];
    if (file === undefined) continue;
    try {
      uploads.push({ slot, name: file.name, data: await downloadFile(file.url) });
    } catch (error) {
      const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined;
      ctx.log.warn({ slot, reason: String(error), cause }, 'Downloading an uploaded image failed');
      throw refuse("I couldn't download that image.");
    }
  }
  return uploads;
}

/**
 * Saves a section change from the editor and redraws the editor in place (`ctx.update`). Wrong input is thrown as a
 * TryAgainError carrying what was typed; the removal of the embed is refused with a plain UserError. A post that
 * couldn't be updated is reported in a follow-up.
 */
export async function saveChange(ctx: ModalContext | ButtonContext, threadId: string, change: SectionChange): Promise<void> {
  const refuse = (message: string): UserError =>
    change.section === 'remove-embed' ? new UserError(message) : new TryAgainError(message, change.section, draftOf(change));
  const uploads = change.section === 'remove-embed' ? [] : await download(ctx, change, refuse);
  const stored = await storeTemplate(
    ctx,
    threadId,
    (current) => {
      try {
        return applySection(current, change, uploads);
      } catch (error) {
        if (error instanceof UserError && !(error instanceof TryAgainError)) throw refuse(error.message);
        throw error;
      }
    },
    { uploads, refuse },
  );
  await ctx.update(editorView(ctx, stored.template, stored.images));
  if (stored.failure !== null) {
    await ctx.followUp({ content: `Saved, but the post couldn't be updated: ${stored.failure}`, ephemeral: true });
  }
}
