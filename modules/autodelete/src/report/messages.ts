import { MAX_REPORT_TEXT, fenced, fitReport, formatDuration, textSection, type ReportBlock, type ReportLayout, type WebhookMessage } from '@bronto/core';
import { foldedDiff } from './diff.js';

export const MAX_TEXT = MAX_REPORT_TEXT;

export type ReportKind = 'replaced' | 'rejected' | 'left';
export type ReportNote = 'gone' | 'forbidden' | 'dmClosed';

const AMBER = 0xf0b232;
const RED = 0xf23f43;
const GRAY = 0x80848e;
const BLURPLE = 0x5865f2;

export interface ReportInput {
  guildId: string;
  channelId: string;
  memberId: string;
  /** The post the button opens: the new post (replaced) or the member's current post (rejected); null for none. */
  jumpMessageId: string | null;
  /** The removed post's text; null when it could not be fetched. */
  removedText: string | null;
  removedAttachments: number;
  /** The other side of the diff: the new post (replaced) or the member's current post (rejected); null when unknown. */
  otherText: string | null;
  /** When the removed post was posted. */
  postedAt: Date;
  /** When the member may post again (rejected). */
  nextPostAt: Date;
  /** When the member joined (left); null when unknown. */
  joinedAt: Date | null;
  /** Whether the member got a copy by DM (rejected). */
  dmSent: boolean;
  notes: ReportNote[];
}

export interface DmInput {
  guildId: string;
  channelId: string;
  /** The text of the removed post. */
  text: string;
  attachmentCount: number;
  /** The member's current post the button opens (rejected); null for none. */
  jumpMessageId: string | null;
  cooldownMs: number;
  nextPostAt: Date;
}

/** Which texts go into attachments instead of the message body. */
interface Mode {
  diffFile: boolean;
  textFile: boolean;
}

const MODES: Mode[] = [
  { diffFile: false, textFile: false },
  { diffFile: true, textFile: false },
  { diffFile: true, textFile: true },
];

const time = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:R>`;
const attachments = (count: number) => `${count} attachment${count === 1 ? '' : 's'}`;
/** The text to show for a post: its content, or its attachment count when it has no text. */
const shown = (text: string, count: number) => (text === '' && count > 0 ? attachments(count) : text);
const jumpUrl = (guildId: string, channelId: string, messageId: string) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const GONE_LINES: Record<ReportKind, string> = {
  replaced: 'The previous post was already gone.',
  rejected: 'The new post was already gone.',
  left: 'The post was already gone.',
};

function noteLines(kind: ReportKind, input: ReportInput): string[] {
  const lines: Record<ReportNote, string> = {
    gone: GONE_LINES[kind],
    forbidden: `I couldn't delete this. I need Manage Messages in <#${input.channelId}>.`,
    dmClosed: "Couldn't send them a copy, their DMs are closed.",
  };
  return input.notes.map((note) => lines[note]);
}

/** A section with the diff of two texts, inline or as the file `changes.diff`. */
function diffSection(title: string, before: string, after: string, mode: Mode, layout: ReportLayout): ReportBlock[] {
  const diff = foldedDiff(before, after);
  if (diff === '') return [{ kind: 'text', text: `**${title}**\nNo text changed.` }];
  if (!mode.diffFile) return [{ kind: 'text', text: `**${title}**\n${fenced(diff, 'diff')}` }];
  layout.files.push({ name: 'changes.diff', data: Buffer.from(diff) });
  return [{ kind: 'text', text: `**${title}**` }, { kind: 'file', name: 'changes.diff' }];
}

/** A report for moderators about a removed post (spec: Mod reports). */
export function reportMessage(kind: ReportKind, input: ReportInput): WebhookMessage {
  const { guildId, channelId, memberId } = input;
  const member = `<@${memberId}>`;
  const channel = `<#${channelId}>`;
  const forbidden = input.notes.includes('forbidden');
  const removed = input.removedText === null ? null : shown(input.removedText, input.removedAttachments);
  const notes = noteLines(kind, input);

  const build = (mode: Mode, layout: ReportLayout): ReportBlock[] => {
    const blocks: ReportBlock[] = [];
    const text = (value: string) => blocks.push({ kind: 'text', text: value });
    if (kind === 'replaced') {
      text(`## Replaced an older post\n${member} posted a new post in ${channel}, so their previous one was removed.`);
      blocks.push({ kind: 'separator' });
      if (removed !== null && input.otherText !== null) blocks.push(...diffSection('What changed', removed, input.otherText, mode, layout));
      text(`Previous post posted ${time(input.postedAt)}`);
    } else if (kind === 'rejected') {
      const outcome = forbidden ? '' : ` The new post was removed${input.dmSent ? ' and they got a copy by DM' : ''}.`;
      text(`## Held back a new post\n${member} tried to post in ${channel} again, but the cooldown runs until ${time(input.nextPostAt)}.${outcome}`);
      blocks.push({ kind: 'separator' });
      if (removed !== null && input.otherText !== null) {
        blocks.push(...diffSection('Compared to their current post', input.otherText, removed, mode, layout));
      }
    } else {
      text(`## Removed the post of a member who left\n${member} left the server, so their post in ${channel} was removed.`);
      blocks.push({ kind: 'separator' });
      if (removed !== null) blocks.push(...textSection('Removed post', removed, mode.textFile, layout));
      const joined = input.joinedAt === null ? 'Posted' : `Joined ${time(input.joinedAt)} · posted`;
      text(`${joined} ${time(input.postedAt)}`);
    }
    if (notes.length > 0) text(notes.join('\n'));
    if (input.jumpMessageId !== null && kind !== 'left') {
      blocks.push({
        kind: 'button',
        label: kind === 'replaced' ? 'Jump to new post' : 'Jump to current post',
        url: jumpUrl(guildId, channelId, input.jumpMessageId),
      });
    }
    return blocks;
  };

  const accent = kind === 'replaced' ? AMBER : kind === 'rejected' ? RED : GRAY;
  return fitReport(MODES, accent, build);
}

/** A DM to a member with a copy of their removed post (spec: DMs to the member). */
export function dmMessage(kind: 'replaced' | 'rejected', input: DmInput): WebhookMessage {
  const channel = `<#${input.channelId}>`;
  const copy = shown(input.text, input.attachmentCount);
  const build = (mode: Mode, layout: ReportLayout): ReportBlock[] => {
    const blocks: ReportBlock[] = [];
    if (kind === 'rejected') {
      blocks.push({
        kind: 'text',
        text:
          `## Your post in ${channel} wasn't published\n` +
          `You can post there once every ${formatDuration(input.cooldownMs)}, and your next post is possible ${time(input.nextPostAt)}. ` +
          'You can edit your current post at any time.',
      });
    } else {
      blocks.push({
        kind: 'text',
        text:
          `## Your older post in ${channel} was replaced\n` +
          "Only your newest post stays in that channel, so the previous one was removed. Here's a copy in case you need anything from it.",
      });
    }
    blocks.push({ kind: 'separator' });
    blocks.push(...textSection(kind === 'rejected' ? 'A copy of what you wrote' : 'Your previous post', copy, mode.textFile, layout));
    if (kind === 'rejected' && input.jumpMessageId !== null) {
      blocks.push({ kind: 'button', label: 'Go to your current post', url: jumpUrl(input.guildId, input.channelId, input.jumpMessageId) });
    }
    return blocks;
  };
  return fitReport(MODES, BLURPLE, build);
}
