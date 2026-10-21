import { defineButton, defineModal, UserError, type ButtonDefinition } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  RESTJSONErrorCodes,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
} from 'discord.js';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeEmbed, validateTemplate } from './content.js';
import type { TemplatesContext } from './context.js';
import { IMAGE_SLOTS, templateImages, templates, type ImageSlot } from './db/schema.js';
import { templatesEvents, templatesGates } from './events.js';
import { requireEditor, templateForThread } from './permissions.js';
import { updatePreview } from './posts.js';
import { render } from './render.js';
import { exportJson, parseTemplateJson } from './transfer.js';

const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_IMPORT_TEXT = 4000;
const MAX_IMPORT_FILE_BYTES = 1_000_000;
const UPLOAD_PREFIX = 'attachment://';

/** A preview button: signed for the template's thread, without arguments or expiry. */
function previewButton(name: string, execute: ButtonDefinition['execute']): ButtonDefinition {
  return defineButton({ name, bind: { channel: true }, ephemeral: true, execute });
}

const SLOT_URLS: Record<ImageSlot, (embed: APIEmbed) => string | undefined> = {
  image: (embed) => embed.image?.url,
  thumbnail: (embed) => embed.thumbnail?.url,
  author_icon: (embed) => embed.author?.icon_url,
  footer_icon: (embed) => embed.footer?.icon_url,
};

function clearSlot(embed: APIEmbed, slot: ImageSlot): void {
  if (slot === 'image') delete embed.image;
  else if (slot === 'thumbnail') delete embed.thumbnail;
  else if (slot === 'author_icon' && embed.author) delete embed.author.icon_url;
  else if (slot === 'footer_icon' && embed.footer) delete embed.footer.icon_url;
}

export const editButton = previewButton('edit', () => {
  throw new UserError('Not available yet.');
});

export const exportButton = previewButton('export', async (ctx) => {
  requireEditor(ctx);
  const template = await templateForThread(ctx, ctx.channelId!);
  const message = await render(ctx, template.id);
  if (message === null) throw new UserError('This template no longer exists.');
  // The time of posting is filled in at post time; it isn't part of the template's content.
  if (template.showPostTime && message.embed !== null) delete message.embed.timestamp;
  const base = template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  await ctx.reply({ files: [{ attachment: Buffer.from(exportJson(message)), name: `${base || 'template'}.json` }] });
});

/** The text of the uploaded `.json` file, or null when the form has none. */
async function uploadedText(ctx: Parameters<typeof importModal.execute>[0]): Promise<string | null> {
  const file = ctx.interaction.fields.getUploadedFiles('file')?.first();
  if (file === undefined) return null;
  if (!file.name.toLowerCase().endsWith('.json')) throw new UserError('The file must be a .json file.');
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new UserError('The file is too large.');
  const failure = new UserError("I couldn't download that file.");
  try {
    const response = await fetch(file.url);
    if (!response.ok) throw failure;
    return await response.text();
  } catch {
    throw failure;
  }
}

export const importModal = defineModal({
  name: 'import',
  bind: { channel: true },
  ephemeral: true,
  execute: async (ctx) => {
    requireEditor(ctx);
    const template = await templateForThread(ctx, ctx.channelId!);
    const text = (await uploadedText(ctx)) ?? ctx.field('json');
    if (text.trim() === '') throw new UserError('Paste template JSON or upload a .json file.');
    const parsed = parseTemplateJson(text);

    // An exported file may still reference the template's uploaded images; those stay only where the template
    // has the same upload now. Other `attachment://` links would point at nothing.
    const embed = parsed.embed === null ? null : structuredClone(parsed.embed);
    for (const slot of IMAGE_SLOTS) {
      const url = embed === null ? undefined : SLOT_URLS[slot](embed);
      if (embed !== null && url?.startsWith(UPLOAD_PREFIX) && url !== SLOT_URLS[slot](template.embed ?? {})) {
        clearSlot(embed, slot);
      }
    }
    const message = { content: parsed.content, embed: embed === null ? null : normalizeEmbed(embed) };
    const problem = validateTemplate(message);
    if (problem !== null) throw new UserError(problem);

    const removed = IMAGE_SLOTS.filter((slot) => {
      const url = message.embed === null ? undefined : SLOT_URLS[slot](message.embed);
      return !url?.startsWith(UPLOAD_PREFIX);
    });
    const updated = await ctx.db.run(async (tx) => {
      const [row] = await tx.update(templates).set(message).where(eq(templates.id, template.id)).returning();
      if (row === undefined) throw new UserError('This template no longer exists.');
      await tx.delete(templateImages).where(and(eq(templateImages.templateId, template.id), inArray(templateImages.slot, removed)));
      return row;
    });
    ctx.emit(templatesEvents.updated, { id: updated.id });
    await updatePreview(ctx, updated, [], { syncAttachments: true });
    await ctx.reply('Template imported.');
  },
});

export const importButton = previewButton('import', async (ctx) => {
  requireEditor(ctx);
  await templateForThread(ctx, ctx.channelId!);
  const json = new TextInputBuilder()
    .setCustomId('json')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_IMPORT_TEXT)
    .setRequired(false);
  const file = new FileUploadBuilder().setCustomId('file').setMinValues(0).setMaxValues(1).setRequired(false);
  await ctx.showModal(
    new ModalBuilder()
      .setCustomId(ctx.customId(importModal))
      .setTitle('Import template')
      .addLabelComponents(
        new LabelBuilder().setLabel('Template JSON').setTextInputComponent(json),
        new LabelBuilder().setLabel('Or a .json file').setFileUploadComponent(file),
      ),
  );
});

export const deleteConfirmButton = defineButton({
  name: 'delete-confirm',
  bind: { user: true, channel: true },
  expiresAfterMs: CONFIRM_TTL_MS,
  ephemeral: true,
  execute: async (ctx) => {
    requireEditor(ctx);
    const template = await templateForThread(ctx, ctx.channelId!);
    const verdict = await ctx.check(templatesGates.deleting, { id: template.id });
    if (!verdict.allowed) {
      await ctx.reply(`Can't delete this template:\n${verdict.reasons.map((reason) => `• ${reason}`).join('\n')}`);
      return;
    }
    await ctx.db.run(async (tx) => {
      await tx.delete(templates).where(eq(templates.id, template.id));
    });
    try {
      await deleteThread(ctx, template.threadId);
    } finally {
      ctx.emit(templatesEvents.deleted, { id: template.id });
    }
    await ctx.reply('Template deleted.');
  },
});

async function deleteThread(ctx: TemplatesContext, threadId: string): Promise<void> {
  try {
    const thread = await ctx.client.channels.fetch(threadId);
    await thread?.delete();
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return;
    throw error;
  }
}

export const deleteButton = previewButton('delete', async (ctx) => {
  requireEditor(ctx);
  const template = await templateForThread(ctx, ctx.channelId!);
  const confirm = new ButtonBuilder()
    .setCustomId(ctx.customId(deleteConfirmButton))
    .setLabel('Delete')
    .setStyle(ButtonStyle.Danger);
  await ctx.reply({
    content: `Delete "${template.name}" and its post? This can't be undone.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
  });
});

export const previewButtons = [editButton, exportButton, importButton, deleteButton];
export const previewComponents = [...previewButtons, importModal, deleteConfirmButton];
