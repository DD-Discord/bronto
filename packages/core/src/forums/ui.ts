import { FileUploadBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type Client } from 'discord.js';
import { isUnknownChannel } from '../discord/index.js';
import { downloadFile } from '../files/index.js';
import type { ModalContext } from '../interactions/context.js';
import { UserError } from '../interactions/errors.js';

export const MAX_IMPORT_TEXT = 4000;
export const MAX_IMPORT_FILE_BYTES = 1_000_000;
const MAX_LISTED = 50;
// Discord's limit for message content.
const MAX_CONTENT = 2000;

/** Whether the channel still exists on Discord; only Unknown Channel counts as gone. */
export async function channelExists(client: Client, channelId: string): Promise<boolean> {
  try {
    await client.channels.fetch(channelId, { force: true });
    return true;
  } catch (error) {
    if (isUnknownChannel(error)) return false;
    throw error;
  }
}

/** Deletes a thread; one that is already gone counts as done. */
export async function deleteThread(client: Client, threadId: string): Promise<void> {
  try {
    const thread = await client.channels.fetch(threadId);
    await thread?.delete();
  } catch (error) {
    if (isUnknownChannel(error)) return;
    throw error;
  }
}

/** The text of the `.json` file uploaded in the modal's `file` input, or null when it has none. */
export async function uploadedJson(ctx: ModalContext): Promise<string | null> {
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

/** An import modal: a `json` paragraph and an optional `file` upload, both read back by `uploadedJson` and `ctx.field`. */
export function importModal(input: { customId: string; title: string; label: string; description?: string }): ModalBuilder {
  const json = new TextInputBuilder().setCustomId('json').setStyle(TextInputStyle.Paragraph).setMaxLength(MAX_IMPORT_TEXT).setRequired(false);
  const file = new FileUploadBuilder().setCustomId('file').setMinValues(0).setMaxValues(1).setRequired(false);
  const jsonLabel = new LabelBuilder().setLabel(input.label).setTextInputComponent(json);
  if (input.description !== undefined) jsonLabel.setDescription(input.description);
  return new ModalBuilder()
    .setCustomId(input.customId)
    .setTitle(input.title)
    .addLabelComponents(jsonLabel, new LabelBuilder().setLabel('Or a .json file').setFileUploadComponent(file));
}

/** The name of an export file: the lower-cased name with runs of other characters as `-`, or `fallback`, plus `.json`. */
export function exportFileName(name: string, fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return `${base || fallback}.json`;
}

/** Escapes the characters that would end a Markdown link's text or target early. */
export function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]()]/g, '\\$&');
}

const moreLine = (count: number) => `…and ${count} more`;

/**
 * One line per record, sorted by name, each linking to its thread and followed by ` · suffix` when set. Cut to 50
 * records and one message, with a final `…and N more` line for the rest. Expects at least one row.
 */
export function recordList(input: { guildId: string; rows: { name: string; threadId: string; suffix?: string }[] }): string {
  const rows = [...input.rows].sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const lines: string[] = [];
  for (const row of rows.slice(0, MAX_LISTED)) {
    const link = `[${escapeLinkText(row.name)}](https://discord.com/channels/${input.guildId}/${row.threadId})`;
    const line = row.suffix === undefined ? link : `${link} · ${row.suffix}`;
    const rest = rows.length - lines.length - 1;
    const text = [...lines, line].join('\n') + (rest > 0 ? `\n${moreLine(rest)}` : '');
    if (text.length > MAX_CONTENT) break;
    lines.push(line);
  }
  if (lines.length < rows.length) lines.push(moreLine(rows.length - lines.length));
  return lines.join('\n');
}
