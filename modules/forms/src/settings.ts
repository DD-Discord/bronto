import { defineModal, type ButtonContext, type ReplyMessage } from '@bronto/core';
import {
  ChannelSelectMenuBuilder,
  ChannelType,
  CheckboxGroupBuilder,
  escapeMarkdown,
  LabelBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
} from 'discord.js';
import type { FormsContext } from './context.js';
import type { Form } from './db/schema.js';
import { MAX_NAME, type FormSettings } from './model.js';
import { actingMember, formById, formForThread, requireEditor } from './permissions.js';
import { editorBinding } from './binding.js';
import { registerRetry, retryReply, TryAgainError, type Draft, type SettingsInput } from './retry.js';
import { changeForm, savedMessage } from './save.js';

// Discord's limit for the values of one select.
const MAX_SELECTED = 25;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread] as const;

export const settingsInputOf = (form: Form): SettingsInput => ({
  name: form.name,
  channelId: form.channelId,
  pingUserIds: form.pingUserIds,
  pingRoleIds: form.pingRoleIds,
  allowedRoleIds: form.allowedRoleIds,
  active: form.active,
  oncePerMember: form.oncePerMember,
});

/**
 * The settings modal, filled with `input`. `inPlace` is for a modal opened from a private message (Try again), whose
 * submit edits that message; opened from the public preview, the submit answers with a new private message.
 */
export function settingsModalFor(ctx: FormsContext, form: Form, input: SettingsInput, inPlace = false): ModalBuilder {
  const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(MAX_NAME).setValue(input.name.slice(0, MAX_NAME));
  const channel = new ChannelSelectMenuBuilder()
    .setCustomId('channel')
    .addChannelTypes(...CHANNEL_TYPES)
    .setPlaceholder('This post')
    .setMinValues(0)
    .setMaxValues(1)
    .setRequired(false);
  if (input.channelId !== null) channel.addDefaultChannels(input.channelId);
  const pings = new MentionableSelectMenuBuilder().setCustomId('pings').setPlaceholder('Pinged by each submission').setMinValues(0).setMaxValues(MAX_SELECTED).setRequired(false);
  pings.addDefaultUsers(input.pingUserIds).addDefaultRoles(input.pingRoleIds);
  const roles = new RoleSelectMenuBuilder().setCustomId('roles').setPlaceholder('Everyone when empty').setMinValues(0).setMaxValues(MAX_SELECTED).setRequired(false);
  roles.addDefaultRoles(input.allowedRoleIds);
  const options = new CheckboxGroupBuilder()
    .setCustomId('options')
    .setMinValues(0)
    .setMaxValues(2)
    .setRequired(false)
    .addOptions(
      { label: 'Active', value: 'active', description: 'Members can fill in the form', default: input.active },
      { label: 'One submission per member', value: 'once', default: input.oncePerMember },
    );
  return new ModalBuilder()
    .setCustomId(ctx.customId(settingsModalDefinition, inPlace ? [form.id, 'edit'] : [form.id]))
    .setTitle('Form settings')
    .addLabelComponents(
      new LabelBuilder().setLabel('Name').setTextInputComponent(name),
      new LabelBuilder().setLabel('Submissions channel').setDescription('Leave empty to post submissions in this form\'s post.').setChannelSelectMenuComponent(channel),
      new LabelBuilder().setLabel('Pings').setDescription('Users and roles pinged by each submission.').setMentionableSelectMenuComponent(pings),
      new LabelBuilder().setLabel('Allowed roles').setDescription('Only these roles can fill in the form.').setRoleSelectMenuComponent(roles),
      new LabelBuilder().setLabel('Options').setCheckboxGroupComponent(options),
    );
}

registerRetry('settings', (ctx, form, draft) => settingsModalFor(ctx, form, draft.input, true));

/** Answers the preview's Settings button with the modal. */
export async function openSettings(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  await ctx.showModal(settingsModalFor(ctx, form, settingsInputOf(form)));
}

type Checked = Pick<FormSettings, 'channelId' | 'pingRoleIds'>;

/**
 * Why the member may not set these settings, or null when they may: pinging a role they can't mention, pinging
 * @everyone, or sending submissions to a channel they can't view. Only what differs from `current` is checked, so
 * other changes can be saved over values someone else set.
 */
export async function checkSettingsAllowed(ctx: FormsContext, member: GuildMember, settings: Checked, current: Checked): Promise<string | null> {
  const guild = member.guild;
  const kept = new Set(current.pingRoleIds);
  for (const roleId of settings.pingRoleIds) {
    if (kept.has(roleId)) continue;
    // The @everyone role has the ID of the server.
    if (roleId === guild.id) return "A submission can't ping @everyone.";
    const role = guild.roles.cache.get(roleId);
    if (role === undefined) return `The role <@&${roleId}> no longer exists.`;
    if (!role.mentionable && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return `You can't mention the role **${escapeMarkdown(role.name)}**, so submissions can't ping it.`;
    }
  }
  if (settings.channelId !== null && settings.channelId !== current.channelId) {
    const channel = await ctx.client.channels.fetch(settings.channelId).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownChannel) return null;
      throw error;
    });
    if (channel === null || channel.isDMBased() || channel.guildId !== guild.id) return `The channel <#${settings.channelId}> doesn't exist in this server.`;
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) return `You can't see <#${settings.channelId}>, so submissions can't go there.`;
  }
  return null;
}

export const settingsModalDefinition = defineModal({
  name: 'settings-modal',
  ...editorBinding,
  // A submit from the preview answers with a new message; acknowledging without one keeps that possible after a defer.
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const formId = args[0] ?? '';
    const answer = (message: ReplyMessage) => (args[1] === 'edit' ? ctx.update(message) : ctx.reply(message));
    const fields = ctx.interaction.fields;
    const pings = fields.getSelectedMentionables('pings');
    const chosen = fields.getCheckboxGroup('options');
    const input: SettingsInput = {
      name: ctx.field('name').trim(),
      channelId: fields.getSelectedChannels('channel')?.first()?.id ?? null,
      pingUserIds: [...(pings?.users.keys() ?? [])],
      pingRoleIds: [...(pings?.roles.keys() ?? [])],
      allowedRoleIds: [...(fields.getSelectedRoles('roles')?.keys() ?? [])],
      active: chosen.includes('active'),
      oncePerMember: chosen.includes('once'),
    };
    const draft: Draft = { kind: 'settings', input };
    try {
      if (input.name === '') throw new TryAgainError("The name can't be empty.", draft);
      const form = await formById(ctx, formId);
      const reason = await checkSettingsAllowed(ctx, await actingMember(ctx), input, form);
      if (reason !== null) throw new TryAgainError(reason, draft);
      const { postUpdated } = await changeForm(ctx, formId, () => ({
        name: input.name,
        active: input.active,
        channelId: input.channelId,
        pingUserIds: input.pingUserIds,
        pingRoleIds: input.pingRoleIds,
        allowedRoleIds: input.allowedRoleIds,
        oncePerMember: input.oncePerMember,
      }));
      await answer({ content: savedMessage('Settings saved.', postUpdated), components: [] });
    } catch (error) {
      if (!(error instanceof TryAgainError)) throw error;
      await answer(retryReply(ctx, formId, error));
    }
  },
});
