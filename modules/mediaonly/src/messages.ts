import { fitReport, textSection, type ReportBlock, type ReportLayout, type WebhookMessage } from '@bronto/core';
import type { MediaProblem } from './check.js';

export type ReportNote = 'forbidden' | 'dmClosed' | 'dmFailed';

const RED = 0xf23f43;
const BLURPLE = 0x5865f2;

/** Whether the post's text goes into a `post.txt` attachment instead of the message body. */
const MODES = [false, true] as const;

/** What posts of a rule channel need, completing "Posts there …". */
const NEEDS: Record<MediaProblem, string> = {
  'no-media': 'need an attachment or a link',
  'not-spoilered': 'need every attachment marked as spoiler and every link wrapped in `||`',
};

const attachments = (count: number) => `${count} attachment${count === 1 ? '' : 's'}`;

/** The short message in the rule channel, mentioning the poster. */
export function noticeText(posterId: string, problem: MediaProblem): string {
  return `<@${posterId}> Your post was removed. Posts here ${NEEDS[problem]}.`;
}

export interface DmInput {
  channelId: string;
  problem: MediaProblem;
  text: string;
  attachmentCount: number;
}

/** A DM to the poster: where and why their post was removed, with a copy of their text. */
export function dmMessage(input: DmInput): WebhookMessage {
  const build = (inFile: boolean, layout: ReportLayout): ReportBlock[] => {
    const blocks: ReportBlock[] = [
      { kind: 'text', text: `## Your post in <#${input.channelId}> was removed\nPosts there ${NEEDS[input.problem]}.` },
    ];
    if (input.text !== '') {
      blocks.push({ kind: 'separator' });
      blocks.push(...textSection('A copy of what you wrote', input.text, inFile, layout));
    }
    if (input.attachmentCount > 0) blocks.push({ kind: 'text', text: `-# Attachments aren't copied; add them again when you repost.` });
    return blocks;
  };
  return fitReport(MODES, BLURPLE, build);
}

export interface ReportInput {
  channelId: string;
  posterId: string;
  problem: MediaProblem;
  text: string;
  attachmentCount: number;
  notes: ReportNote[];
}

const NOTE_LINES: Record<ReportNote, (channelId: string) => string> = {
  forbidden: (channelId) => `I couldn't delete this. I need Manage Messages in <#${channelId}>.`,
  dmClosed: () => "Couldn't tell them by DM, their DMs are closed.",
  dmFailed: () => "Couldn't send them a DM.",
};

/** A report for moderators about a post that failed the media check. */
export function reportMessage(input: ReportInput): WebhookMessage {
  const forbidden = input.notes.includes('forbidden');
  const what = input.problem === 'no-media' ? 'a post without media' : "a post that wasn't spoilered";
  const build = (inFile: boolean, layout: ReportLayout): ReportBlock[] => {
    const blocks: ReportBlock[] = [
      {
        kind: 'text',
        text: `## ${forbidden ? "Couldn't remove" : 'Removed'} ${what}\n<@${input.posterId}> posted in <#${input.channelId}>, but posts there ${NEEDS[input.problem]}.`,
      },
      { kind: 'separator' },
    ];
    if (input.text !== '') blocks.push(...textSection('Removed post', input.text, inFile, layout));
    blocks.push({ kind: 'text', text: `-# ${attachments(input.attachmentCount)}` });
    if (input.notes.length > 0) blocks.push({ kind: 'text', text: input.notes.map((note) => NOTE_LINES[note](input.channelId)).join('\n') });
    return blocks;
  };
  return fitReport(MODES, RED, build);
}
