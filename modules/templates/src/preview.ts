import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIEmbed,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import { deleteButton, editButton, exportButton, importButton } from './buttons.js';
import type { TemplateMessage } from './content.js';
import type { TemplatesContext } from './context.js';
import type { ImageSlot, Template } from './db/schema.js';
import { setSlot } from './render.js';

/** An image to attach to the preview message for one embed slot. */
export type PendingUpload = { slot: ImageSlot; name: string; data: Buffer };

/** The preview's file name for an upload, `<slot>.<ext>`; the extension comes from the uploaded name. */
export function uploadFileName(upload: PendingUpload): string {
  const ext = /\.([a-z0-9]{1,10})$/i.exec(upload.name)?.[1]?.toLowerCase() ?? 'png';
  return `${upload.slot}.${ext}`;
}

/**
 * The embed with each upload's slot pointing at its attachment (`attachment://<slot>.<ext>`), creating the embed when
 * there is none; `unplaced` lists icon slots without the author name or footer text they belong to.
 */
export function withUploads(embed: APIEmbed | null, uploads: PendingUpload[]): { embed: APIEmbed | null; unplaced: ImageSlot[] } {
  if (uploads.length === 0) return { embed, unplaced: [] };
  const result: APIEmbed = embed === null ? {} : structuredClone(embed);
  const unplaced: ImageSlot[] = [];
  for (const upload of uploads) {
    if (!setSlot(result, upload.slot, `attachment://${uploadFileName(upload)}`)) unplaced.push(upload.slot);
  }
  return { embed: result, unplaced };
}

/** The preview without its buttons: content and embed as they will be posted, uploads attached. */
export function previewBody(message: TemplateMessage, uploads: PendingUpload[] = []) {
  const { embed } = withUploads(message.embed, uploads);
  return {
    content: message.content,
    embeds: embed === null ? [] : [embed],
    // An empty file list would remove the attachments an edit keeps.
    ...(uploads.length === 0 ? {} : { files: uploads.map((upload) => ({ attachment: upload.data, name: uploadFileName(upload) })) }),
    allowedMentions: { parse: [] },
  } satisfies MessageCreateOptions;
}

/** `[Edit] [Export] [Import] [Delete]`, signed for the template's thread. */
export function previewButtonRow(ctx: TemplatesContext, threadId: string): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const button = (definition: typeof editButton, label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(ctx.customId(definition, [], { channelId: threadId })).setLabel(label).setStyle(style);
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    button(editButton, 'Edit', ButtonStyle.Primary),
    button(exportButton, 'Export', ButtonStyle.Secondary),
    button(importButton, 'Import', ButtonStyle.Secondary),
    button(deleteButton, 'Delete', ButtonStyle.Danger),
  );
}

/** The starter message of a template's post: the template as it will be posted, uploads attached, and its buttons. */
export function previewMessage(ctx: TemplatesContext, template: Template, uploads: PendingUpload[] = []) {
  return { ...previewBody(template, uploads), components: [previewButtonRow(ctx, template.threadId)] } satisfies MessageCreateOptions;
}
