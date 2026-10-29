import { defineButton, defineModal, downloadFile, UserError, type ButtonDefinition, isUnknownChannel } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
} from 'discord.js';
import type { TemplatesContext } from './context.js';
import { IMAGE_SLOTS, type ImageSlot, type TemplateImage } from './db/schema.js';
import { openEditor } from './editor.js';
import { templatesGates } from './events.js';
import { forgetTemplate } from './lifecycle.js';
import { requireEditor, templateForThread } from './permissions.js';
import { clearSlot, render, setSlot, slotUrl } from './render.js';
import { storeTemplate } from './save.js';
import { exportJson, parseTemplateJson } from './transfer.js';

const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_IMPORT_TEXT = 4000;
const MAX_IMPORT_FILE_BYTES = 1_000_000;
const UPLOAD_PREFIX = 'attachment://';
// Captures the attachment ID of a Discord attachment link.
const ATTACHMENT_LINK = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\//;

/** A preview button: signed for the template's thread, without arguments or expiry. */
function previewButton(name: string, execute: ButtonDefinition['execute']): ButtonDefinition {
  return defineButton({ name, bind: { channel: true }, ephemeral: true, execute });
}

/**
 * The imported embed with uploaded images kept. An exported file carries the template's uploads as Discord links; a
 * link to the attachment a slot holds now (same attachment ID; the signature changes) maps back to that slot's
 * `attachment://` value. Any other `attachment://` value would point at nothing and is cleared.
 */
function keepUploads(imported: APIEmbed, currentEmbed: APIEmbed | null, stored: TemplateImage[]): APIEmbed {
  const embed = structuredClone(imported);
  for (const slot of IMAGE_SLOTS) {
    const url = slotUrl(embed, slot);
    if (url === undefined) continue;
    const current = slotUrl(currentEmbed ?? {}, slot);
    const keeps = current?.startsWith(UPLOAD_PREFIX) === true;
    if (url.startsWith(UPLOAD_PREFIX)) {
      if (!keeps || url !== current) clearSlot(embed, slot);
      continue;
    }
    const attachmentId = ATTACHMENT_LINK.exec(url)?.[1];
    if (keeps && attachmentId !== undefined && stored.some((image) => image.slot === slot && image.attachmentId === attachmentId)) {
      setSlot(embed, slot, current!);
    }
  }
  return embed;
}

export const editButton = previewButton('edit', (ctx) => openEditor(ctx));

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
    return (await downloadFile(file.url, MAX_IMPORT_FILE_BYTES)).toString('utf8');
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
    await templateForThread(ctx, ctx.channelId!);
    const text = (await uploadedText(ctx)) ?? ctx.field('json');
    if (text.trim() === '') throw new UserError('Paste template JSON or upload a .json file.');
    const parsed = parseTemplateJson(text);
    const { failure } = await storeTemplate(ctx, ctx.channelId!, (current, stored) => ({
      content: parsed.content,
      embed: parsed.embed === null ? null : keepUploads(parsed.embed, current.embed, stored),
    }));
    await ctx.reply(failure === null ? 'Template imported.' : `Saved, but the post couldn't be updated: ${failure}`);
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
  defer: 'update',
  execute: async (ctx) => {
    requireEditor(ctx);
    const template = await templateForThread(ctx, ctx.channelId!);
    const verdict = await ctx.check(templatesGates.deleting, { id: template.id });
    if (!verdict.allowed) {
      await ctx.update({ content: `Can't delete this template:\n${verdict.reasons.map((reason) => `• ${reason}`).join('\n')}`, components: [] });
      return;
    }
    // The interaction lives in the thread, so it is answered before the thread goes away.
    await ctx.update({ content: 'Template deleted.', components: [] });
    await forgetTemplate(ctx, template);
    try {
      await deleteThread(ctx, template.threadId);
    } catch (error) {
      ctx.log.warn({ err: error, threadId: template.threadId }, 'Deleting the post of a deleted template failed');
      await ctx.followUp({ content: "Template deleted, but its post couldn't be removed.", ephemeral: true });
    }
  },
});

async function deleteThread(ctx: TemplatesContext, threadId: string): Promise<void> {
  try {
    const thread = await ctx.client.channels.fetch(threadId);
    await thread?.delete();
  } catch (error) {
    if (isUnknownChannel(error)) return;
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
