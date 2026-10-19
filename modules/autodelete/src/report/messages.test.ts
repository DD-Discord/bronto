import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { dmMessage, MAX_TEXT, reportMessage, type DmInput, type ReportInput } from './messages.js';

const POSTED = new Date('2026-03-01T12:00:00Z');
const NEXT = new Date('2026-03-15T12:00:00Z');
const JOINED = new Date('2026-01-01T00:00:00Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

type Node = { type: number; content?: string; label?: string; url?: string; accent_color?: number; components?: Node[]; file?: { url: string } };

const container = (message: ReturnType<typeof reportMessage>): Node => (message.components as unknown as Node[])[0]!;
const walk = (nodes: Node[]): Node[] => nodes.flatMap((node) => [node, ...walk(node.components ?? [])]);
const nodes = (message: ReturnType<typeof reportMessage>) => walk([container(message)]);
const texts = (message: ReturnType<typeof reportMessage>) => nodes(message).filter((n) => n.type === 10).map((n) => n.content!);
const button = (message: ReturnType<typeof reportMessage>) => nodes(message).find((n) => n.type === 2);
/** What Discord counts against the limit: text displays and button labels. */
const textSize = (message: ReturnType<typeof reportMessage>) =>
  nodes(message).reduce((sum, n) => sum + (n.content?.length ?? 0) + (n.type === 2 ? (n.label?.length ?? 0) : 0), 0);

const base: ReportInput = {
  guildId: 'G',
  channelId: 'C',
  memberId: 'M1',
  jumpMessageId: 'M',
  removedText: 'old line\nsame',
  removedAttachments: 0,
  otherText: 'new line\nsame',
  postedAt: POSTED,
  nextPostAt: NEXT,
  joinedAt: JOINED,
  dmSent: false,
  notes: [],
};

describe('reportMessage', () => {
  it('builds a replaced report', () => {
    const message = reportMessage('replaced', base);
    expect(message.flags).toBe(MessageFlags.IsComponentsV2);
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(container(message).accent_color).toBe(0xf0b232);
    const all = texts(message).join('\n');
    expect(all).toContain('Replaced an older post');
    expect(all).toContain('<@M1> posted a new post in <#C>, so their previous one was removed.');
    expect(all).toContain('What changed');
    expect(all).toContain('```diff\n- old line\n+ new line\n  same\n```');
    expect(all).toContain(`Previous post posted <t:${seconds(POSTED)}:R>`);
    expect(button(message)).toMatchObject({ label: 'Jump to new post', style: 5, url: 'https://discord.com/channels/G/C/M' });
  });

  it('builds a held-back report with a copy sent note', () => {
    const message = reportMessage('rejected', { ...base, removedText: 'rejected', otherText: 'current', dmSent: true });
    expect(container(message).accent_color).toBe(0xf23f43);
    const all = texts(message).join('\n');
    expect(all).toContain('Held back a new post');
    expect(all).toContain(`<@M1> tried to post in <#C> again, but the cooldown runs until <t:${seconds(NEXT)}:R>.`);
    expect(all).toContain('The new post was removed and they got a copy by DM.');
    expect(all).toContain('Compared to their current post');
    expect(all).toContain('- current\n+ rejected');
    expect(button(message)).toMatchObject({ label: 'Jump to current post', url: 'https://discord.com/channels/G/C/M' });
  });

  it('has no button and no diff without a current post', () => {
    const message = reportMessage('rejected', { ...base, jumpMessageId: null, otherText: null });
    expect(button(message)).toBeUndefined();
    expect(texts(message).join('\n')).not.toContain('Compared to');
    expect(texts(message).join('\n')).not.toContain('The new post was removed and they got a copy');
  });

  it('builds a left report', () => {
    const message = reportMessage('left', { ...base, jumpMessageId: null, removedText: 'goodbye' });
    expect(container(message).accent_color).toBe(0x80848e);
    const all = texts(message).join('\n');
    expect(all).toContain('Removed the post of a member who left');
    expect(all).toContain('<@M1> left the server, so their post in <#C> was removed.');
    expect(all).toContain('Removed post');
    expect(all).toContain('```\ngoodbye\n```');
    expect(all).toContain(`Joined <t:${seconds(JOINED)}:R> · posted <t:${seconds(POSTED)}:R>`);
    expect(button(message)).toBeUndefined();
  });

  it('leaves out the join time when unknown', () => {
    const all = texts(reportMessage('left', { ...base, joinedAt: null })).join('\n');
    expect(all).toContain(`Posted <t:${seconds(POSTED)}:R>`);
    expect(all).not.toContain('Joined');
  });

  it('adds the lines for notes', () => {
    const all = texts(reportMessage('replaced', { ...base, removedText: null, notes: ['gone', 'forbidden', 'dmClosed'] })).join('\n');
    expect(all).toContain('The previous post was already gone.');
    expect(all).toContain("I couldn't delete this. I need Manage Messages in <#C>.");
    expect(all).toContain("Couldn't send them a copy, their DMs are closed.");
    expect(all).not.toContain('What changed');
  });

  it('shows attachments-only posts as a count', () => {
    const left = texts(reportMessage('left', { ...base, removedText: '', removedAttachments: 2 })).join('\n');
    expect(left).toContain('```\n2 attachments\n```');
    const replaced = texts(reportMessage('replaced', { ...base, removedText: '', removedAttachments: 1 })).join('\n');
    expect(replaced).toContain('- 1 attachment\n');
  });

  it('escapes fences', () => {
    const message = reportMessage('replaced', { ...base, removedText: 'a ``` b', otherText: '```js\ncode' });
    const diff = texts(message).find((text) => text.includes('What changed'))!;
    expect(diff.match(/```/g)).toHaveLength(2);
  });

  it('mentions never ping', () => {
    const message = reportMessage('left', { ...base, removedText: '@everyone <@&123> <@456>' });
    expect(message.allowedMentions).toEqual({ parse: [] });
  });

  it('keeps a 2857-character post and its diff within the text limit', () => {
    const post = 'x'.repeat(2857);
    const message = reportMessage('replaced', { ...base, removedText: post, otherText: `${post}y` });
    expect(textSize(message)).toBeLessThanOrEqual(MAX_TEXT);
  });

  it('moves a diff that does not fit into changes.diff', () => {
    const before = Array.from({ length: 400 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `new ${i}`).join('\n');
    const message = reportMessage('replaced', { ...base, removedText: before, otherText: after });
    expect(textSize(message)).toBeLessThanOrEqual(MAX_TEXT);
    expect(message.files).toHaveLength(1);
    expect(message.files![0]!.name).toBe('changes.diff');
    expect(message.files![0]!.data.toString()).toContain('- old 0\n- old 1');
    expect(nodes(message).find((n) => n.type === 13)?.file?.url).toBe('attachment://changes.diff');
  });

  it('moves a long removed text into post.txt', () => {
    const text = 'z'.repeat(4500);
    const message = reportMessage('left', { ...base, removedText: text });
    expect(textSize(message)).toBeLessThanOrEqual(MAX_TEXT);
    expect(message.files).toEqual([{ name: 'post.txt', data: Buffer.from(text) }]);
    expect(nodes(message).find((n) => n.type === 13)?.file?.url).toBe('attachment://post.txt');
  });
});

const dmBase: DmInput = {
  guildId: 'G',
  channelId: 'C',
  text: 'my words',
  attachmentCount: 0,
  jumpMessageId: 'M',
  cooldownMs: 1_209_600_000,
  nextPostAt: NEXT,
};

describe('dmMessage', () => {
  it('builds the held-back copy', () => {
    const message = dmMessage('rejected', dmBase);
    expect(message.flags).toBe(MessageFlags.IsComponentsV2);
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(container(message).accent_color).toBe(0x5865f2);
    const all = texts(message).join('\n');
    expect(all).toContain("Your post in <#C> wasn't published");
    expect(all).toContain(`You can post there once every 2w, and your next post is possible <t:${seconds(NEXT)}:R>. You can edit your current post at any time.`);
    expect(all).toContain('A copy of what you wrote');
    expect(all).toContain('```\nmy words\n```');
    expect(button(message)).toMatchObject({ label: 'Go to your current post', url: 'https://discord.com/channels/G/C/M' });
  });

  it('has no button without a current post', () => {
    expect(button(dmMessage('rejected', { ...dmBase, jumpMessageId: null }))).toBeUndefined();
  });

  it('builds the replaced copy', () => {
    const message = dmMessage('replaced', dmBase);
    const all = texts(message).join('\n');
    expect(all).toContain('Your older post in <#C> was replaced');
    expect(all).toContain('Only your newest post stays in that channel, so the previous one was removed.');
    expect(all).toContain('Your previous post');
    expect(all).toContain('```\nmy words\n```');
    expect(button(message)).toBeUndefined();
  });

  it('attaches a copy that does not fit', () => {
    const text = 'q'.repeat(4200);
    const message = dmMessage('replaced', { ...dmBase, text });
    expect(textSize(message)).toBeLessThanOrEqual(MAX_TEXT);
    expect(message.files).toEqual([{ name: 'post.txt', data: Buffer.from(text) }]);
  });
});
