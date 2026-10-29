import {
  defineButton,
  defineModal,
  deleteThread,
  exportFileName,
  importModal as importModalBuilder,
  uploadedJson,
  UserError,
  type ButtonContext,
} from '@bronto/core';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { eq } from 'drizzle-orm';
import { openers, type Form } from './db/schema.js';
import { forgetForm } from './lifecycle.js';
import { exportForm, importForm, newFieldId, type Field, type FormSettings } from './model.js';
import { actingMember, formById, formForThread, requireEditor } from './permissions.js';
import { editorBinding } from './binding.js';
import { changeForm, savedMessage } from './save.js';
import { checkSettingsAllowed } from './settings.js';

const settingsOf = (form: Form): FormSettings => ({
  name: form.name,
  active: form.active,
  channelId: form.channelId,
  pingUserIds: form.pingUserIds,
  pingRoleIds: form.pingRoleIds,
  allowedRoleIds: form.allowedRoleIds,
  oncePerMember: form.oncePerMember,
  answersApart: form.answersApart,
});

/** Answers the preview's Export button with the form as a `.json` file. */
export async function exportFormFile(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  await ctx.reply({ files: [{ attachment: Buffer.from(exportForm(settingsOf(form), form.fields)), name: exportFileName(form.name, 'form') }] });
}

/**
 * The imported fields with IDs that are safe to use: one that was removed from this form before, or that changes its
 * type, gets a new ID, so old answers never turn up under it again.
 */
function usableIds(imported: Field[], current: Form): Field[] {
  const used = new Set([...imported.map((field) => field.id), ...current.fields.map((field) => field.id), ...current.removedFieldIds]);
  const removed = new Set(current.removedFieldIds);
  const types = new Map(current.fields.map((field) => [field.id, field.type]));
  return imported.map((field) => {
    // A field whose type changes is a new field: answers of the old type never turn up under it.
    const retyped = types.has(field.id) && types.get(field.id) !== field.type;
    if (!removed.has(field.id) && !retyped) return field;
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
    const text = (await uploadedJson(ctx)) ?? ctx.field('json');
    if (text.trim() === '') throw new UserError('Paste form JSON or upload a .json file.');
    const parsed = importForm(text);
    const reason = await checkSettingsAllowed(ctx, await actingMember(ctx), parsed.settings, form);
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
  await ctx.showModal(
    importModalBuilder({
      customId: ctx.customId(importModal),
      title: 'Import form',
      label: 'Form JSON',
      description: 'Replaces the settings and all fields.',
    }),
  );
}

/** Why the form can't be deleted: its buttons must go first. */
const blockedMessage = (form: Form, channels: string[]) =>
  `Can't delete "${form.name}" while it has form buttons. Remove them in ${channels.map((id) => `<#${id}>`).join(' ')} first.`;

export const deleteConfirmButton = defineButton({
  name: 'delete-confirm',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const result = await forgetForm(ctx, form, { refuseWithOpeners: true });
    if (typeof result === 'object') {
      await ctx.update({ content: blockedMessage(form, result.blockedBy), components: [] });
      return;
    }
    if (!result) throw new UserError('This form no longer exists.');
    // The interaction lives in the post, so it is answered before the post goes away.
    await ctx.update({ content: 'Form deleted.', components: [] });
    try {
      await deleteThread(ctx.client, form.threadId);
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
  const held = await ctx.db.run(async (tx) => tx.selectDistinct({ channelId: openers.channelId }).from(openers).where(eq(openers.formId, form.id)).orderBy(openers.channelId));
  if (held.length > 0) throw new UserError(blockedMessage(form, held.map((row) => row.channelId)));
  const confirm = new ButtonBuilder().setCustomId(ctx.customId(deleteConfirmButton, [form.id])).setLabel('Delete').setStyle(ButtonStyle.Danger);
  await ctx.reply({
    content: `Delete "${form.name}" and its post? Its submissions are deleted too. This can't be undone.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
  });
}

export const transferComponents = [importModal, deleteConfirmButton];
