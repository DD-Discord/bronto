import { defineButton, defineModal, downloadFile, UserError, type ButtonContext, type ModalContext } from '@bronto/core';
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
} from 'discord.js';
import { eq } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { openers, type Form } from './db/schema.js';
import { forgetForm } from './lifecycle.js';
import { exportForm, importForm, newFieldId, type Field, type FormSettings } from './model.js';
import { actingMember, formById, formForThread, requireEditor } from './permissions.js';
import { editorBinding } from './retry.js';
import { changeForm, savedMessage } from './save.js';
import { checkSettingsAllowed } from './settings.js';

const MAX_IMPORT_TEXT = 4000;
const MAX_IMPORT_FILE_BYTES = 1_000_000;

const settingsOf = (form: Form): FormSettings => ({
  name: form.name,
  active: form.active,
  channelId: form.channelId,
  pingUserIds: form.pingUserIds,
  pingRoleIds: form.pingRoleIds,
  allowedRoleIds: form.allowedRoleIds,
  oncePerMember: form.oncePerMember,
});

/** Answers the preview's Export button with the form as a `.json` file. */
export async function exportFormFile(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  const base = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  await ctx.reply({ files: [{ attachment: Buffer.from(exportForm(settingsOf(form), form.fields)), name: `${base || 'form'}.json` }] });
}

/** The text of the uploaded `.json` file, or null when the modal has none. */
async function uploadedText(ctx: ModalContext): Promise<string | null> {
  const file = ctx.interaction.fields.getUploadedFiles('file')?.first();
  if (file === undefined) return null;
  if (!file.name.toLowerCase().endsWith('.json')) throw new UserError('The file must be a .json file.');
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new UserError('The file is too large.');
  try {
    return (await downloadFile(file.url, MAX_IMPORT_FILE_BYTES)).toString('utf8');
  } catch {
    throw new UserError("I couldn't download that file.");
  }
}

/**
 * The imported fields with IDs that are safe to use: one that was removed from this form before gets a new ID, so
 * old answers never turn up under it again.
 */
function usableIds(imported: Field[], current: Form): Field[] {
  const used = new Set([...imported.map((field) => field.id), ...current.fields.map((field) => field.id), ...current.removedFieldIds]);
  const removed = new Set(current.removedFieldIds);
  return imported.map((field) => {
    if (!removed.has(field.id)) return field;
    const id = newFieldId(used);
    used.add(id);
    return { ...field, id };
  });
}

export const importModal = defineModal({
  name: 'import',
  bind: { channel: true },
  ephemeral: true,
  execute: async (ctx) => {
    requireEditor(ctx);
    const form = await formForThread(ctx, ctx.channelId!);
    const text = (await uploadedText(ctx)) ?? ctx.field('json');
    if (text.trim() === '') throw new UserError('Paste form JSON or upload a .json file.');
    const parsed = importForm(text);
    const reason = await checkSettingsAllowed(ctx, await actingMember(ctx), parsed.settings);
    if (reason !== null) throw new UserError(reason);
    const { postUpdated } = await changeForm(ctx, form.id, (current) => {
      const fields = usableIds(parsed.fields, current);
      const kept = new Set(fields.map((field) => field.id));
      const dropped = current.fields.map((field) => field.id).filter((id) => !kept.has(id));
      return {
        ...parsed.settings,
        fields,
        removedFieldIds: [...new Set([...current.removedFieldIds, ...dropped])],
      };
    });
    await ctx.reply(savedMessage('Form imported.', postUpdated));
  },
});

/** Answers the preview's Import button with the modal. */
export async function openImport(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  await formForThread(ctx, ctx.channelId!);
  const json = new TextInputBuilder().setCustomId('json').setStyle(TextInputStyle.Paragraph).setMaxLength(MAX_IMPORT_TEXT).setRequired(false);
  const file = new FileUploadBuilder().setCustomId('file').setMinValues(0).setMaxValues(1).setRequired(false);
  await ctx.showModal(
    new ModalBuilder()
      .setCustomId(ctx.customId(importModal))
      .setTitle('Import form')
      .addLabelComponents(
        new LabelBuilder().setLabel('Form JSON').setDescription('Replaces the settings and all fields.').setTextInputComponent(json),
        new LabelBuilder().setLabel('Or a .json file').setFileUploadComponent(file),
      ),
  );
}

/** Why the form can't be deleted, or null: its openers must go first. */
async function deleteBlocker(ctx: FormsContext, form: Form): Promise<string | null> {
  const rows = await ctx.db.run(async (tx) => tx.select({ channelId: openers.channelId }).from(openers).where(eq(openers.formId, form.id)));
  if (rows.length === 0) return null;
  const channels = [...new Set(rows.map((row) => `<#${row.channelId}>`))].join(' ');
  return `Can't delete "${form.name}" while it has openers. Remove them in ${channels} first.`;
}

async function deleteThread(ctx: FormsContext, threadId: string): Promise<void> {
  try {
    const thread = await ctx.client.channels.fetch(threadId);
    await thread?.delete();
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return;
    throw error;
  }
}

export const deleteConfirmButton = defineButton({
  name: 'delete-confirm',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const blocker = await deleteBlocker(ctx, form);
    if (blocker !== null) {
      await ctx.update({ content: blocker, components: [] });
      return;
    }
    // The interaction lives in the post, so it is answered before the post goes away.
    await ctx.update({ content: 'Form deleted.', components: [] });
    await forgetForm(ctx, form);
    try {
      await deleteThread(ctx, form.threadId);
    } catch (error) {
      ctx.log.warn({ err: error, threadId: form.threadId }, 'Deleting the post of a deleted form failed');
      await ctx.followUp({ content: "Form deleted, but its post couldn't be removed.", ephemeral: true });
    }
  },
});

/** Answers the preview's Delete button with a confirmation, or the reason the form can't go. */
export async function askDelete(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  const blocker = await deleteBlocker(ctx, form);
  if (blocker !== null) throw new UserError(blocker);
  const confirm = new ButtonBuilder().setCustomId(ctx.customId(deleteConfirmButton, [form.id])).setLabel('Delete').setStyle(ButtonStyle.Danger);
  await ctx.reply({
    content: `Delete "${form.name}" and its post? Its submissions are deleted too. This can't be undone.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
  });
}

export const transferComponents = [importModal, deleteConfirmButton];
