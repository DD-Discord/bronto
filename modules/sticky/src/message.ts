import type { APIEmbed, APIEmbedField } from 'discord.js';

/** What a sticky posts. */
export interface StickyMessage {
  content: string;
  embeds: APIEmbed[];
}

type Loose = Record<string, unknown>;

const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function sendableEmbed(embed: Loose): APIEmbed {
  const out: APIEmbed = {};
  if (text(embed.title)) out.title = text(embed.title);
  if (text(embed.description)) out.description = text(embed.description);
  if (text(embed.url)) out.url = text(embed.url);
  if (text(embed.timestamp)) out.timestamp = text(embed.timestamp);
  if (typeof embed.color === 'number') out.color = embed.color;
  if (isRecord(embed.footer) && text(embed.footer.text)) {
    out.footer = { text: text(embed.footer.text)! };
    if (text(embed.footer.icon_url)) out.footer.icon_url = text(embed.footer.icon_url);
  }
  if (isRecord(embed.image) && text(embed.image.url)) out.image = { url: text(embed.image.url)! };
  if (isRecord(embed.thumbnail) && text(embed.thumbnail.url)) out.thumbnail = { url: text(embed.thumbnail.url)! };
  if (isRecord(embed.author) && text(embed.author.name)) {
    out.author = { name: text(embed.author.name)! };
    if (text(embed.author.url)) out.author.url = text(embed.author.url);
    if (text(embed.author.icon_url)) out.author.icon_url = text(embed.author.icon_url);
  }
  if (Array.isArray(embed.fields)) {
    const fields: APIEmbedField[] = [];
    for (const field of embed.fields) {
      if (!isRecord(field) || !text(field.name) || !text(field.value)) continue;
      const kept: APIEmbedField = { name: text(field.name)!, value: text(field.value)! };
      if (typeof field.inline === 'boolean') kept.inline = field.inline;
      fields.push(kept);
    }
    if (fields.length > 0) out.fields = fields;
  }
  return out;
}

const showsSomething = (embed: APIEmbed): boolean =>
  Boolean(embed.title ?? embed.description ?? embed.fields ?? embed.image ?? embed.thumbnail ?? embed.author ?? embed.footer);

/**
 * The embeds of a received message as a webhook may send them: Discord's own additions (IDs, types, proxy URLs,
 * sizes) are dropped, and so are embeds left with nothing to show.
 */
export function sendableEmbeds(value: unknown): APIEmbed[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(sendableEmbed).filter(showsSomething);
}

const MESSAGE_LINK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/;

/** The IDs in a message link (Discord's "Copy Message Link"), or null for anything else. */
export function parseMessageLink(link: string): { guildId: string; channelId: string; messageId: string } | null {
  const match = MESSAGE_LINK.exec(link.trim());
  if (match === null) return null;
  return { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}
