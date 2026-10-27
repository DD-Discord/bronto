import type { ReplyMessage } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  SeparatorBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { addFieldButton, deleteButton, editFieldButton, exportButton, importButton, settingsButton, tryButton } from './buttons.js';
import type { FormsContext } from './context.js';
import type { Form } from './db/schema.js';
import { pages, type Field } from './model.js';

// Discord caps the text of all text displays and button labels in a message at 4000 characters.
const TEXT_BUDGET = 4000;

const TYPE_NAMES: Record<Field['type'], string> = {
  short: 'short text',
  long: 'long text',
  select: 'select menu',
  radio: 'radio buttons',
  checkboxes: 'checkboxes',
  file: 'file upload',
};

const mentions = (prefix: string, ids: string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `<${prefix}${id}>`).join(' '));

function pings(form: Form): string {
  const all = [...form.pingUserIds.map((id) => `<@${id}>`), ...form.pingRoleIds.map((id) => `<@&${id}>`)];
  return all.length === 0 ? 'none' : all.join(' ');
}

function settingsSummary(form: Form): string {
  return [
    `## ${form.name}`,
    `**${form.active ? 'Active' : 'Inactive'}** · ${form.oncePerMember ? 'once per member' : 'many per member'}`,
    `Submissions: ${form.channelId === null ? 'this post' : `<#${form.channelId}>`}`,
    `Pings: ${pings(form)}`,
    `Allowed roles: ${form.allowedRoleIds.length === 0 ? 'everyone' : mentions('@&', form.allowedRoleIds)}`,
  ].join('\n');
}

/** The numbered field list by page, cut with `… and N more` once it would exceed `budget` characters. */
function fieldList(fields: Field[], budget: number): string {
  if (fields.length === 0) return '*No fields yet.*';
  const lines: string[] = [];
  let used = 0;
  let number = 0;
  let shown = 0;
  const pageList = pages(fields);
  outer: for (const [pageIndex, page] of pageList.entries()) {
    const heading = pageList.length > 1 ? `**Page ${pageIndex + 1}**` : null;
    for (const [i, field] of page.entries()) {
      number++;
      const line = `${number}. ${field.label} · ${TYPE_NAMES[field.type]} · ${field.required ? 'required' : 'optional'}`;
      const extra = (i === 0 && heading !== null ? heading.length + 1 : 0) + line.length + 1;
      const more = `… and ${fields.length - shown - 1} more`;
      const reserve = shown + 1 < fields.length ? more.length + 1 : 0;
      if (used + extra + reserve > budget) break outer;
      if (i === 0 && heading !== null) lines.push(heading);
      lines.push(line);
      used += extra;
      shown++;
    }
  }
  if (shown < fields.length) lines.push(`… and ${fields.length - shown} more`);
  return lines.join('\n');
}

/** A button signed for the form's thread. */
function button(ctx: FormsContext, definition: typeof addFieldButton, threadId: string, label: string, style: ButtonStyle, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(ctx.customId(definition, [], { channelId: threadId }))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

type PreviewButton = { definition: typeof addFieldButton; label: string; style: ButtonStyle; disabled?: boolean };

/** The preview's button rows; their labels count toward Discord's text limit. */
function buttonRows(form: Form): PreviewButton[][] {
  return [
    [
      { definition: addFieldButton, label: 'Add field', style: ButtonStyle.Primary },
      { definition: editFieldButton, label: 'Edit field', style: ButtonStyle.Secondary, disabled: form.fields.length === 0 },
      { definition: settingsButton, label: 'Settings', style: ButtonStyle.Secondary },
      { definition: tryButton, label: 'Try it', style: ButtonStyle.Secondary, disabled: form.fields.length === 0 },
    ],
    [
      { definition: exportButton, label: 'Export', style: ButtonStyle.Secondary },
      { definition: importButton, label: 'Import', style: ButtonStyle.Secondary },
      { definition: deleteButton, label: 'Delete', style: ButtonStyle.Danger },
    ],
  ];
}

/** The starter message of a form's post: its settings and fields, and the buttons that change them. */
export function previewMessage(ctx: FormsContext, form: Form): ReplyMessage {
  const summary = settingsSummary(form);
  const rows = buttonRows(form);
  const labels = rows.flat().reduce((sum, entry) => sum + entry.label.length, 0);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(summary))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldList(form.fields, TEXT_BUDGET - summary.length - labels)))
    .addActionRowComponents(
      rows.map((row) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          row.map((entry) => button(ctx, entry.definition, form.threadId, entry.label, entry.style, entry.disabled)),
        ),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Edits the post's starter message to show the form. An archived post is unarchived and the edit retried once. */
export async function updatePreview(ctx: FormsContext, form: Form): Promise<void> {
  const thread = await ctx.client.channels.fetch(form.threadId);
  if (thread === null || !thread.isThread()) throw new Error(`Form post ${form.threadId} is not a thread.`);
  const message = previewMessage(ctx, form);
  const options = () => ({ components: message.components, flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] } });
  try {
    await thread.messages.edit(form.previewMessageId, options());
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread)) throw error;
    await thread.setArchived(false);
    await thread.messages.edit(form.previewMessageId, options());
  }
}
