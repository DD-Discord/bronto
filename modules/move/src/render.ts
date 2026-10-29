import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, GuildMember, Message, MessageSnapshot, User } from 'discord.js';
import { MessageReferenceType, StickerFormatType } from 'discord.js';
import type { Plan, StayReason } from './classify.js';

const ZERO_WIDTH_SPACE = '\u200b';
const FORBIDDEN_NAME_WORDS = /(d)(iscord)|(c)(lyde)/gi;
const EXCERPT_LENGTH = 40;
const MAX_EMBEDS = 10;

export type ReplyTarget = { name: string; link: string; text: string } | 'deleted' | null;

export interface RepostFile {
  url: string;
  name: string;
  description?: string;
  spoiler: boolean;
  /** 0 when unknown before downloading (sticker images, files only an embed shows). */
  size: number;
  /** The attachment ID, for uploaded files of the original. */
  id?: string;
}

export type LinkRow = APIActionRowComponent<APIComponentInMessageActionRow>;

export interface RepostPart {
  content: string;
  embeds: APIEmbed[];
  files: RepostFile[];
  /** Action rows of link buttons. */
  components: LinkRow[];
}

/** The name a file is uploaded under; `attachment://` links use it. */
export const uploadName = (file: RepostFile): string => (file.spoiler ? `SPOILER_${file.name}` : file.name);

/** Server nickname, else global display name, else username. */
export function displayName(member: GuildMember | null, user: User): string {
  return member?.nickname ?? user.globalName ?? user.username;
}

/** A name Discord accepts for a webhook message: at most 80 characters, without "discord" or "clyde". */
export function webhookName(name: string): string {
  const broken = name.replace(FORBIDDEN_NAME_WORDS, (_, a, b, c, d) => `${a ?? c}${ZERO_WIDTH_SPACE}${b ?? d}`);
  const cut = Array.from(broken).slice(0, 80).join('').trim();
  return cut === '' ? 'Unknown' : cut;
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

const escapeChars = (text: string): string => text.replace(/[\\*_~|>#[\]()`]/g, '\\$&');

/** Escapes the characters Discord reads as markdown, and a leading `-` (of `-#`). */
function escapeMarkdown(text: string): string {
  return escapeChars(text).replace(/^-/, '\\-');
}

/** Escapes text and wraps its links in `<>`, so they show no preview. */
function inlineSafe(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    out += `${escapeChars(text.slice(last, match.index))}<${match[0]}>`;
    last = match.index + match[0].length;
  }
  return (out + escapeChars(text.slice(last))).replace(/^-/, '\\-');
}

/**
 * About the first 40 characters of a message as plain text: spoilers hidden (an unclosed `||` hides the rest), code
 * marks dropped, cut at a word break. Safe to place inside a line of markdown.
 */
function excerpt(text: string): string {
  const plain = text
    .replace(/\|\|[\s\S]*?\|\|/g, '(spoiler)')
    .replace(/\|\|[\s\S]*$/, '(spoiler)')
    .replace(/```[\w+-]*\n/g, ' ')
    .replace(/`/g, '')
    .replace(/<(https?:\/\/[^\s<>]+)>/g, '$1');
  const flat = plain.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(attachment)';
  const chars = Array.from(flat);
  if (chars.length <= EXCERPT_LENGTH) return inlineSafe(flat);
  const head = chars.slice(0, EXCERPT_LENGTH).join('');
  const space = head.lastIndexOf(' ');
  return `${inlineSafe((space > 0 ? head.slice(0, space) : head).trimEnd())}…`;
}

/** The one-line pointer to the replied message. */
export function replyLine(target: NonNullable<ReplyTarget>): string {
  if (target === 'deleted') return '-# ↪ (deleted message)';
  return `-# ↪ [@${escapeMarkdown(target.name)}](<${target.link}>) ${excerpt(target.text)}`;
}

/** Cuts a position that would split a surrogate pair back by one. */
function safeCut(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff && index > 1 ? index - 1 : index;
}

/**
 * Splits text into parts of at most `limit` characters, `firstPrefix` included in the first. Breaks at a line break,
 * else a space, else cuts hard. Parts are never empty.
 */
export function splitContent(text: string, firstPrefix: string, limit = 2000): string[] {
  const parts: string[] = [];
  let rest = text;
  let prefix = firstPrefix;
  for (;;) {
    const budget = Math.max(1, limit - prefix.length);
    if (rest.length <= budget) {
      parts.push(prefix + rest);
      break;
    }
    const window = rest.slice(0, budget + 1);
    let cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    const separator = cut > 0;
    if (!separator) cut = safeCut(rest, budget);
    parts.push(prefix + rest.slice(0, cut));
    rest = rest.slice(separator ? cut + 1 : cut);
    prefix = '';
  }
  return parts.map((part) => part.trimEnd()).filter((part) => part !== '');
}

const NOTICES: Record<StayReason, string> = {
  'too-large': 'Attachment too large to move',
  poll: 'Poll not moved',
  thread: 'Has a thread',
  'forum-start': 'Original post',
  interactive: 'Interactive message not moved',
};
const NOTICE_ORDER: StayReason[] = ['too-large', 'poll', 'thread', 'forum-start', 'interactive'];

/** The files a message carries (its own, then those of forwarded messages), as reposts would upload them. */
export function messageFiles(message: Message): RepostFile[] {
  const attachments = [...message.attachments.values(), ...[...message.messageSnapshots.values()].flatMap((snapshot) => [...snapshot.attachments.values()])];
  return attachments.map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    name: attachment.name.replace(/^SPOILER_/, ''),
    ...(attachment.description ? { description: attachment.description } : {}),
    spoiler: attachment.spoiler || attachment.name.startsWith('SPOILER_'),
    size: attachment.size,
  }));
}

/** Splits files into those that fit the per-file and total upload limit (in order) and those that don't. */
export function fitFiles(files: RepostFile[], limit: number, used = 0): { fit: RepostFile[]; dropped: RepostFile[] } {
  const fit: RepostFile[] = [];
  const dropped: RepostFile[] = [];
  let total = used;
  for (const file of files) {
    if (file.size > limit || total + file.size > limit) dropped.push(file);
    else {
      fit.push(file);
      total += file.size;
    }
  }
  return { fit, dropped };
}

const STICKER_EXTENSIONS: Partial<Record<StickerFormatType, string>> = {
  [StickerFormatType.PNG]: 'png',
  [StickerFormatType.APNG]: 'png',
  [StickerFormatType.GIF]: 'gif',
};

function stickerImage(messages: (Message | MessageSnapshot)[]): { lines: string[]; files: RepostFile[] } {
  const lines: string[] = [];
  const files: RepostFile[] = [];
  for (const sticker of messages.flatMap((message) => [...message.stickers.values()])) {
    lines.push(`-# Sticker: ${sticker.name}`);
    // Message stickers carry no guild, so standard and custom ones are alike; Lottie stickers have no image.
    const extension = STICKER_EXTENSIONS[sticker.format];
    if (extension !== undefined) files.push({ url: sticker.url, name: `${sticker.name}.${extension}`, spoiler: false, size: 0 });
  }
  return { lines, files };
}

const quote = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

const ATTACHMENT_LINK = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\/([^/?#]+)/;

/** The image slots of an embed that can show an uploaded file, as getter and setter. */
function imageSlots(embed: APIEmbed): { get: () => string | undefined; set: (url: string) => void }[] {
  const slots: { get: () => string | undefined; set: (url: string) => void }[] = [];
  const { image, thumbnail, author, footer } = embed;
  if (image) slots.push({ get: () => image.url, set: (url) => void (image.url = url) });
  if (thumbnail) slots.push({ get: () => thumbnail.url, set: (url) => void (thumbnail.url = url) });
  if (author) slots.push({ get: () => author.icon_url, set: (url) => void (author.icon_url = url) });
  if (footer) slots.push({ get: () => footer.icon_url, set: (url) => void (footer.icon_url = url) });
  return slots;
}

/** The attachment ID an embed URL points at, when it is an uploaded file. */
function linkedId(url: string | undefined): { id: string; name: string } | null {
  const match = url === undefined ? null : ATTACHMENT_LINK.exec(url);
  return match === null ? null : { id: match[1]!, name: decodeURIComponent(match[2]!) };
}

/**
 * Rich embeds to copy, as copies: the message's own when a bot or webhook sent it (a member's are link previews),
 * then those of forwarded messages. At most ten.
 */
function copiedEmbeds(message: Message, snapshots: MessageSnapshot[]): APIEmbed[] {
  const rich = (source: Message | MessageSnapshot) => source.embeds.filter((embed) => (embed.data.type ?? 'rich') === 'rich').map((embed) => structuredClone(embed.toJSON()));
  const own = message.author.bot || message.webhookId !== null ? rich(message) : [];
  return [...own, ...snapshots.flatMap(rich)].slice(0, MAX_EMBEDS);
}

/** Files that embeds show but the message doesn't list, each once, under a name no other file has. */
function embedOnlyFiles(embeds: APIEmbed[], listed: RepostFile[]): RepostFile[] {
  const files: RepostFile[] = [];
  const names = new Set(listed.map(uploadName));
  for (const slot of embeds.flatMap(imageSlots)) {
    const url = slot.get();
    const link = linkedId(url);
    if (link === null || listed.some((file) => file.id === link.id) || files.some((file) => file.id === link.id)) continue;
    const spoiler = link.name.startsWith('SPOILER_');
    const base = link.name.replace(/^SPOILER_/, '');
    let name = base;
    for (let n = 1; names.has(spoiler ? `SPOILER_${name}` : name); n += 1) name = `${n}-${base}`;
    const file: RepostFile = { id: link.id, url: url!, name, spoiler, size: 0 };
    names.add(uploadName(file));
    files.push(file);
  }
  return files;
}

/** Points embed images at the uploaded copies of their files; those not uploaded keep their URL. */
function pointAtUploads(embeds: APIEmbed[], files: RepostFile[]): void {
  for (const slot of embeds.flatMap(imageSlots)) {
    const link = linkedId(slot.get());
    const file = link === null ? undefined : files.find((entry) => entry.id === link.id);
    if (file !== undefined) slot.set(`attachment://${uploadName(file)}`);
  }
}

/** True when an embed shows the file. */
const shown = (embeds: APIEmbed[], file: RepostFile): boolean =>
  file.id !== undefined && embeds.flatMap(imageSlots).some((slot) => linkedId(slot.get())?.id === file.id);

/**
 * Renders one message as consecutive webhook posts. Embeds are rich ones of bots, webhooks and forwarded messages;
 * the files, embeds and link buttons go on the last part, files embeds show first. Files that exceed the upload
 * limit, or are in `missing` (by URL, e.g. a failed download), are dropped with a notice, and embeds showing them
 * keep pointing at the original.
 */
export function renderMessage(
  message: Message,
  plan: Extract<Plan, { kind: 'repost' }>,
  input: { replyTarget: ReplyTarget; uploadLimit: number; originalLink: string; missing?: ReadonlySet<string> },
): RepostPart[] {
  const snapshots = message.reference?.type === MessageReferenceType.Forward ? [...message.messageSnapshots.values()] : [];
  const listed = messageFiles(message);
  const { fit, dropped } = fitFiles(listed, input.uploadLimit);
  const stickers = stickerImage([message, ...snapshots]);
  const used = fit.reduce((sum, file) => sum + file.size, 0);
  // Sticker images have no size before download, so they only count once downloaded; skip them when nothing is left.
  const stickerFiles = used < input.uploadLimit ? stickers.files : [];
  const embeds = copiedEmbeds(message, snapshots);
  const missing = input.missing ?? new Set<string>();
  const files = [...fit, ...stickerFiles, ...embedOnlyFiles(embeds, listed)].filter((file) => !missing.has(file.url));
  // Files beyond the first ten go out on further posts, so those the embeds show come first.
  const ordered = [...files.filter((file) => shown(embeds, file)), ...files.filter((file) => !shown(embeds, file))];
  pointAtUploads(embeds, ordered);

  const reasons = new Set<StayReason>(plan.stays);
  if (dropped.length > 0) reasons.add('too-large');

  const pieces: string[] = [];
  if (message.content !== '') pieces.push(message.content);
  for (const snapshot of snapshots) pieces.push(snapshot.content ? `-# Forwarded\n${quote(snapshot.content)}` : '-# Forwarded');
  pieces.push(...stickers.lines);
  for (const reason of NOTICE_ORDER) {
    if (reasons.has(reason)) pieces.push(`-# ${NOTICES[reason]}: [original](<${input.originalLink}>)`);
  }

  const prefix = input.replyTarget === null ? '' : `${replyLine(input.replyTarget)}\n`;
  const contents = splitContent(pieces.join('\n'), prefix);
  if (contents.length === 0) contents.push('');

  // Only link buttons can be carried over; a message with other components stays and its copy has none.
  const components = reasons.has('interactive') ? [] : message.components.map((row) => row.toJSON() as LinkRow);
  return contents.map((content, index) => {
    const last = index === contents.length - 1;
    return { content, embeds: last ? embeds : [], files: last ? ordered : [], components: last ? components : [] };
  });
}
