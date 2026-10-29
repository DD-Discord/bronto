import type { APIEmbed, GuildMember, Message, User } from 'discord.js';
import { MessageReferenceType, StickerFormatType } from 'discord.js';
import type { Plan, StayReason } from './classify.js';

const ZERO_WIDTH_SPACE = '​';
const FORBIDDEN_NAME_WORDS = /(d)(iscord)|(c)(lyde)/gi;
const EXCERPT_LENGTH = 40;
const MAX_EMBEDS = 10;

export type ReplyTarget = { name: string; link: string; text: string } | 'deleted' | null;

export interface RepostFile {
  url: string;
  name: string;
  description?: string;
  spoiler: boolean;
  size: number;
}

export interface RepostPart {
  content: string;
  embeds: APIEmbed[];
  files: RepostFile[];
}

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

function stickerImage(message: Message): { lines: string[]; files: RepostFile[] } {
  const lines: string[] = [];
  const files: RepostFile[] = [];
  for (const sticker of message.stickers.values()) {
    lines.push(`-# Sticker: ${sticker.name}`);
    // Message stickers carry no guild, so standard and custom ones are alike; Lottie stickers have no image.
    const extension = STICKER_EXTENSIONS[sticker.format];
    if (extension !== undefined) files.push({ url: sticker.url, name: `${sticker.name}.${extension}`, spoiler: false, size: 0 });
  }
  return { lines, files };
}

const quote = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

/**
 * Renders one message as consecutive webhook posts. Embeds come only from bots and webhooks; the files and embeds go
 * on the last part, and files that exceed the upload limit are dropped with a notice.
 */
export function renderMessage(
  message: Message,
  plan: Extract<Plan, { kind: 'repost' }>,
  input: { replyTarget: ReplyTarget; uploadLimit: number; originalLink: string },
): RepostPart[] {
  const { fit, dropped } = fitFiles(messageFiles(message), input.uploadLimit);
  const stickers = stickerImage(message);
  const used = fit.reduce((sum, file) => sum + file.size, 0);
  // Sticker images have no size before download, so they only count once downloaded; skip them when nothing is left.
  const stickerFiles = used < input.uploadLimit ? stickers.files : [];

  const reasons = new Set<StayReason>(plan.stays);
  if (dropped.length > 0) reasons.add('too-large');

  const pieces: string[] = [];
  if (message.content !== '') pieces.push(message.content);
  if (message.reference?.type === MessageReferenceType.Forward) {
    for (const snapshot of message.messageSnapshots.values()) {
      pieces.push(snapshot.content ? `-# Forwarded\n${quote(snapshot.content)}` : '-# Forwarded');
    }
  }
  pieces.push(...stickers.lines);
  for (const reason of NOTICE_ORDER) {
    if (reasons.has(reason)) pieces.push(`-# ${NOTICES[reason]}: [original](<${input.originalLink}>)`);
  }

  const prefix = input.replyTarget === null ? '' : `${replyLine(input.replyTarget)}\n`;
  const contents = splitContent(pieces.join('\n'), prefix);
  if (contents.length === 0) contents.push('');

  const embeds = message.author.bot || message.webhookId !== null
    ? message.embeds.filter((embed) => (embed.data.type ?? 'rich') === 'rich').slice(0, MAX_EMBEDS).map((embed) => embed.toJSON())
    : [];
  return contents.map((content, index) => {
    const last = index === contents.length - 1;
    return { content, embeds: last ? embeds : [], files: last ? [...fit, ...stickerFiles] : [] };
  });
}
