import { createNativeTestClient, FakeDiscordHttp } from '@bronto/core/testing';
import { StickerFormatType, type GuildTextBasedChannel, type Message } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { displayName, renderMessage, replyLine, splitContent, webhookName, type ReplyTarget } from '../src/render.js';
import { addHistory, addMoveFixtures, MEMBER, SOURCE } from './harness.js';

const LINK = 'https://discord.com/channels/1/2/3';
const ZWSP = '\u200b';

describe('names', () => {
  it('uses nickname, then global name, then username', () => {
    const user = { username: 'user', globalName: 'Global' } as never;
    expect(displayName({ nickname: 'Nick' } as never, user)).toBe('Nick');
    expect(displayName({ nickname: null } as never, user)).toBe('Global');
    expect(displayName(null, { username: 'user', globalName: null } as never)).toBe('user');
  });

  it('breaks discord and clyde in webhook names', () => {
    expect(webhookName('Discord Helper')).toBe(`D${ZWSP}iscord Helper`);
    expect(webhookName('my cLyDe')).toBe(`my c${ZWSP}LyDe`);
    expect(webhookName('Plain')).toBe('Plain');
    expect(webhookName('')).toBe('Unknown');
    expect(webhookName('   ')).toBe('Unknown');
  });

  it('cuts names to 80', () => {
    expect(webhookName('a'.repeat(200))).toHaveLength(80);
    expect(Array.from(webhookName('😀'.repeat(100)))).toHaveLength(80);
  });
});

describe('replyLine', () => {
  it('links and cuts the excerpt at a word', () => {
    const text = 'the quick brown fox jumps over the lazy dog again and again';
    expect(replyLine({ name: 'Ann', link: LINK, text })).toBe(`-# ↪ [@Ann](<${LINK}>) the quick brown fox jumps over the lazy…`);
    expect(replyLine({ name: 'Ann', link: LINK, text: 'short\ntext' })).toBe(`-# ↪ [@Ann](<${LINK}>) short text`);
    expect(replyLine({ name: 'Ann', link: LINK, text: '' })).toBe(`-# ↪ [@Ann](<${LINK}>) (attachment)`);
  });

  const excerptOf = (text: string, name = 'Ann') => replyLine({ name, link: LINK, text }).slice(`-# ↪ [@${name}](<${LINK}>) `.length);

  it('hides spoilers, also unclosed ones', () => {
    expect(excerptOf('see ||the twist|| now')).toBe('see \\(spoiler\\) now');
    expect(excerptOf('a ||b\nc')).toBe('a \\(spoiler\\)');
    expect(excerptOf(`${'word '.repeat(6)}||${'secret '.repeat(10)}||`)).not.toContain('secret');
    expect(excerptOf(`${'word '.repeat(6)}||${'secret '.repeat(10)}`)).not.toContain('secret');
  });

  it('drops code marks', () => {
    expect(excerptOf('```js\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(excerptOf('run `npm test` first')).toBe('run npm test first');
  });

  it('wraps links so they show no preview', () => {
    expect(excerptOf('look https://example.test/a_b here')).toBe('look <https://example.test/a_b> here');
    expect(excerptOf('see <https://example.test>')).toBe('see <https://example.test>');
    expect(excerptOf('[click](https://example.test)')).toBe('\\[click\\]\\(<https://example.test>\\)');
  });

  it('escapes markdown in the name and excerpt', () => {
    expect(excerptOf('**b** _i_ ~~g~~ ||x|| > q # h \\ e')).toBe('\\*\\*b\\*\\* \\_i\\_ \\~\\~g\\~\\~ \\(spoiler\\) \\> q \\# h \\\\ e');
    expect(excerptOf('a | b')).toBe('a \\| b');
    expect(excerptOf('-# tiny')).toBe('\\-\\# tiny');
    expect(replyLine({ name: '*A* [b] (c) `d`', link: LINK, text: 'x' })).toBe(`-# ↪ [@\\*A\\* \\[b\\] \\(c\\) \\\`d\\\`](<${LINK}>) x`);
  });

  it('cuts the plain text at a word, before escaping', () => {
    expect(excerptOf('**aaaa** bbbb cccc dddd eeee ffff gggg hhhh iiii')).toBe('\\*\\*aaaa\\*\\* bbbb cccc dddd eeee ffff gggg…');
  });

  it('writes the deleted line', () => {
    expect(replyLine('deleted')).toBe('-# ↪ (deleted message)');
  });
});

describe('splitContent', () => {
  it('splits at a line break, else a space, else hard', () => {
    expect(splitContent('aaa\nbbb ccc', '', 8)).toEqual(['aaa', 'bbb ccc']);
    expect(splitContent('aaaa bbbb cccc', '', 9)).toEqual(['aaaa bbbb', 'cccc']);
    expect(splitContent('abcdefghij', '', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps the prefix on the first part and never returns empty parts', () => {
    expect(splitContent('', '')).toEqual([]);
    expect(splitContent('', 'reply\n')).toEqual(['reply']);
    expect(splitContent('\n\nabc', '', 3).every((part) => part !== '')).toBe(true);
    const parts = splitContent('x'.repeat(30), 'reply\n', 20);
    expect(parts[0]!.startsWith('reply\n')).toBe(true);
    expect(parts.every((part) => part.length <= 20)).toBe(true);
    expect(parts.join('').replace('reply\n', '')).toBe('x'.repeat(30));
  });
});

describe('renderMessage', () => {
  let discord: FakeDiscordHttp;
  let channel: GuildTextBasedChannel;

  beforeEach(async () => {
    discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    const { client } = await createNativeTestClient(discord);
    channel = (await client.channels.fetch(SOURCE)) as GuildTextBasedChannel;
  });

  const fetchOne = async (spec: Record<string, unknown>): Promise<Message> => {
    const [id] = addHistory(discord, SOURCE, [spec]);
    return channel.messages.fetch(id!);
  };
  const render = async (
    spec: Record<string, unknown>,
    stays: Parameters<typeof renderMessage>[1]['stays'] = [],
    input: { replyTarget?: ReplyTarget; uploadLimit?: number } = {},
  ) =>
    renderMessage(await fetchOne(spec), { kind: 'repost', stays }, { replyTarget: null, uploadLimit: 1000, originalLink: LINK, ...input });

  it('splits 2000/2001/4000 with the reply line on the first part', async () => {
    const replyTarget = { name: 'Ann', link: LINK, text: 'hello' };
    const line = `${replyLine(replyTarget)}\n`;
    const text = (length: number) => Array.from({ length }, (_, i) => (i % 10 === 9 ? ' ' : 'x')).join('');
    const exact = await render({ content: text(2000 - line.length) }, [], { replyTarget });
    expect(exact).toHaveLength(1);
    expect(exact[0]!.content).toHaveLength(2000);
    const over = await render({ content: text(2001 - line.length) }, [], { replyTarget });
    expect(over).toHaveLength(2);
    expect(over[0]!.content.startsWith(line)).toBe(true);
    expect(over[1]!.content.startsWith('-#')).toBe(false);
    const long = await render({ content: text(4000) }, [], { replyTarget });
    expect(long.length).toBeGreaterThanOrEqual(3);
    expect(long.every((part) => part.content.length <= 2000)).toBe(true);
    expect(long[0]!.content.startsWith(line)).toBe(true);
  });

  it('puts files and embeds on the last part', async () => {
    const parts = await render({
      content: 'word '.repeat(500),
            files: [{ filename: 'SPOILER_a.txt', data: 'abc' }],
      embeds: [{ title: 'Hi' }],
    }, [], {});
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ embeds: [], files: [] });
    expect(parts[1]!.files).toMatchObject([{ name: 'a.txt', spoiler: true, size: 3 }]);
  });

  it('drops link-preview embeds of members', async () => {
    const spec = { content: 'x', authorId: MEMBER, embeds: [{ title: 'Preview', url: 'https://example.com' }] };
    expect((await render(spec))[0]!.embeds).toEqual([]);
  });

  it('copies rich embeds of bots, not their link previews', async () => {
    const parts = await render({ embeds: [{ title: 'Rich', type: 'rich' }, { url: 'https://x.test', type: 'link' }] });
    expect(parts[0]!.embeds).toMatchObject([{ title: 'Rich' }]);
  });

  it('writes the sticker line, without an image for a Lottie sticker', async () => {
    const parts = await render({ content: 'hi', stickers: [{ id: '100000000000000500', name: 'Wave', format: StickerFormatType.Lottie }] });
    expect(parts[0]!.content).toBe('hi\n-# Sticker: Wave');
    expect(parts[0]!.files).toEqual([]);
  });

  it('attaches the image of a PNG, APNG or GIF sticker', async () => {
    const parts = await render({
      stickers: [
        { id: '100000000000000500', name: 'Wave', format: StickerFormatType.PNG },
        { id: '100000000000000501', name: 'Spin', format: StickerFormatType.APNG },
        { id: '100000000000000502', name: 'Dance', format: StickerFormatType.GIF },
      ],
    });
    expect(parts[0]!.files).toMatchObject([
      { url: expect.stringContaining('/stickers/100000000000000500.png'), name: 'Wave.png', spoiler: false },
      { url: expect.stringContaining('/stickers/100000000000000501.png'), name: 'Spin.png' },
      { url: expect.stringContaining('/stickers/100000000000000502.gif'), name: 'Dance.gif' },
    ]);
  });

  it('quotes forwards under -# Forwarded', async () => {
    const parts = await render({ snapshots: [{ content: 'line one\nline two', files: [{ filename: 'f.txt', data: 'zz' }] }] });
    expect(parts[0]!.content).toBe('-# Forwarded\n> line one\n> line two');
    expect(parts[0]!.files).toMatchObject([{ name: 'f.txt', size: 2 }]);
  });

  it('adds one notice per stay reason', async () => {
    const parts = await render({ content: 'hi' }, ['poll', 'thread', 'forum-start', 'interactive']);
    expect(parts[0]!.content).toBe([
      'hi',
      `-# Poll not moved: [original](<${LINK}>)`,
      `-# Has a thread: [original](<${LINK}>)`,
      `-# Original post: [original](<${LINK}>)`,
      `-# Interactive message not moved: [original](<${LINK}>)`,
    ].join('\n'));
  });

  it('drops files above the limit and adds the too-large notice', async () => {
    const files = [{ filename: 'ok.bin', data: 'x'.repeat(60) }, { filename: 'big.bin', data: 'x'.repeat(200) }, { filename: 'late.bin', data: 'x'.repeat(60) }];
    const parts = await render({ content: 'hi', files }, ['too-large'], { uploadLimit: 100 });
    expect(parts[0]!.files.map((file) => file.name)).toEqual(['ok.bin']);
    expect(parts[0]!.content).toBe(`hi\n-# Attachment too large to move: [original](<${LINK}>)`);
  });

  it('writes a reply to a deleted message and an empty message', async () => {
    const parts = await render({}, [], { replyTarget: 'deleted' });
    expect(parts).toEqual([{ content: '-# ↪ (deleted message)', embeds: [], files: [] }]);
    expect(await render({})).toEqual([{ content: '', embeds: [], files: [] }]);
  });
});
