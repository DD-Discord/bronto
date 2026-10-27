import type { APIEmbed, APIEmbedField } from 'discord.js';

/** What a template posts: message text and at most one embed. */
export interface TemplateMessage {
  content: string;
  embed: APIEmbed | null;
}

export const LIMITS = { content: 2000, title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256 };
const MAX_FIELDS = 25;
export const MAX_EMBED = 6000;
const COLOR_MESSAGE = 'Colors are hex values like #5865F2.';
const LINK_MESSAGE = 'Links must start with http:// or https://.';

type Loose = Record<string, unknown>;

const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Characters Discord counts towards the 6000 limit: title, description, field names and values, footer text, author name. */
export function embedLength(embed: APIEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  total += (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
  for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  return total;
}

function sanitize(embed: Loose): APIEmbed | null {
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
  const visible = out.title ?? out.description ?? out.fields ?? out.image ?? out.thumbnail ?? out.author ?? out.footer;
  return visible === undefined ? null : out;
}

/** The embed without empty parts, or null when nothing visible remains. */
export function normalizeEmbed(embed: APIEmbed): APIEmbed | null {
  return sanitize(embed as Loose);
}

/**
 * A received embed as a webhook may send it: Discord's own additions (IDs, types, proxy URLs, sizes) are dropped,
 * and so is an embed left with nothing to show.
 */
export function sendableEmbed(value: unknown): APIEmbed | null {
  return isRecord(value) ? sanitize(value) : null;
}

/** A hex color such as `#5865F2` or `5865f2`; `''` means no color. */
export function parseColor(input: string): number | null | 'invalid' {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  return match === null ? 'invalid' : Number.parseInt(match[1]!, 16);
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'attachment:']);

/** A full http(s) or attachment link Discord accepts: it parses, has no whitespace and starts with `<protocol>//`. */
function isLink(url: string): boolean {
  if (/\s/.test(url) || !/^[a-z]+:\/\//i.test(url)) return false;
  try {
    return LINK_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function tooLong(part: string, value: string | undefined, limit: number): string | null {
  return value !== undefined && value.length > limit ? `${part} can be at most ${limit} characters.` : null;
}

function validateEmbed(embed: APIEmbed): string | null {
  const fields = embed.fields ?? [];
  if (fields.length > MAX_FIELDS) return `An embed can have at most ${MAX_FIELDS} fields.`;
  const problem =
    tooLong('Title', embed.title, LIMITS.title) ??
    tooLong('Description', embed.description, LIMITS.description) ??
    tooLong('Footer text', embed.footer?.text, LIMITS.footer) ??
    tooLong('Author name', embed.author?.name, LIMITS.author) ??
    fields.map((f) => tooLong('Field name', f.name, LIMITS.fieldName) ?? tooLong('Field value', f.value, LIMITS.fieldValue)).find((p) => p !== null);
  if (problem) return problem;
  if (embed.color !== undefined && (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)) return COLOR_MESSAGE;
  const urls = [embed.url, embed.author?.url, embed.author?.icon_url, embed.footer?.icon_url, embed.image?.url, embed.thumbnail?.url];
  if (urls.some((url) => url !== undefined && url !== '' && !isLink(url))) return LINK_MESSAGE;
  const length = embedLength(embed);
  return length > MAX_EMBED ? `The embed is longer than ${MAX_EMBED} characters (${length}/${MAX_EMBED}).` : null;
}

/** The first problem with a template as user text, or null when Discord will accept it. */
export function validateTemplate(message: TemplateMessage): string | null {
  const embed = message.embed === null ? null : normalizeEmbed(message.embed);
  if (message.content.trim() === '' && embed === null) return 'A template needs text or an embed.';
  return tooLong('Content', message.content, LIMITS.content) ?? (embed === null ? null : validateEmbed(embed));
}
