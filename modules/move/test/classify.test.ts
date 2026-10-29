import { createNativeTestClient, FakeDiscordHttp } from '@bronto/core/testing';
import { MessageFlags, MessageType, type GuildTextBasedChannel, type Message } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import { addHistory, addMoveFixtures, FORUM_POST, MEMBER, SOURCE, THREAD } from './harness.js';

describe('classify', () => {
  let discord: FakeDiscordHttp;
  let client: Awaited<ReturnType<typeof createNativeTestClient>>['client'];

  beforeEach(async () => {
    discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    client = (await createNativeTestClient(discord)).client;
  });

  const ctx = { uploadLimit: 100, sourceIsForumPost: false, isSticky: () => false };
  const fetchOne = async (channelId: string, spec: Record<string, unknown>): Promise<Message> => {
    const [id] = addHistory(discord, channelId, [spec]);
    const channel = (await client.channels.fetch(channelId)) as GuildTextBasedChannel;
    return channel.messages.fetch(id!);
  };
  const linkButton = { type: 2, style: 5, label: 'Open', url: 'https://example.com' };

  it('skips and deletes joins', async () => {
    expect(classify(await fetchOne(SOURCE, { type: MessageType.UserJoin }), ctx)).toEqual({ kind: 'skip-delete' });
  });

  it('keeps ThreadCreated', async () => {
    expect(classify(await fetchOne(SOURCE, { type: MessageType.ThreadCreated }), ctx)).toEqual({ kind: 'skip-keep' });
  });

  it("keeps a thread's starter message", async () => {
    expect(classify(await fetchOne(THREAD, { type: MessageType.ThreadStarterMessage }), ctx)).toEqual({ kind: 'skip-keep' });
  });

  it('moves plain messages', async () => {
    expect(classify(await fetchOne(SOURCE, { content: 'hi' }), ctx)).toEqual({ kind: 'repost', stays: [] });
  });

  it('poll stays', async () => {
    expect(classify(await fetchOne(SOURCE, { poll: true }), ctx)).toEqual({ kind: 'repost', stays: ['poll'] });
  });

  it('message with thread stays', async () => {
    expect(classify(await fetchOne(SOURCE, { content: 'x', threadId: THREAD, flags: MessageFlags.HasThread }), ctx)).toEqual({ kind: 'repost', stays: ['thread'] });
  });

  it('forum starter stays', async () => {
    const message = await fetchOne(FORUM_POST, { content: 'x' });
    const starter = { ...message, id: FORUM_POST } as unknown as Message;
    Object.setPrototypeOf(starter, message);
    expect(classify(starter, { ...ctx, sourceIsForumPost: true })).toEqual({ kind: 'repost', stays: ['forum-start'] });
    expect(classify(message, { ...ctx, sourceIsForumPost: true })).toEqual({ kind: 'repost', stays: [] });
    expect(classify(starter, ctx)).toEqual({ kind: 'repost', stays: [] });
  });

  it('components other than link buttons stay', async () => {
    const button = { type: 2, style: 1, label: 'Go', custom_id: 'go' };
    const select = { type: 3, custom_id: 's', options: [{ label: 'a', value: 'a' }] };
    for (const row of [[button], [linkButton, button], [select]]) {
      const message = await fetchOne(SOURCE, { components: [{ type: 1, components: row }] });
      expect(classify(message, ctx)).toEqual({ kind: 'repost', stays: ['interactive'] });
    }
    const v2 = await fetchOne(SOURCE, { flags: MessageFlags.IsComponentsV2 });
    expect(classify(v2, ctx)).toEqual({ kind: 'repost', stays: ['interactive'] });
  });

  it('link-button-only messages move', async () => {
    const message = await fetchOne(SOURCE, { components: [{ type: 1, components: [linkButton, linkButton] }] });
    expect(classify(message, ctx)).toEqual({ kind: 'repost', stays: [] });
  });

  it('forwards of polls and components stay', async () => {
    const poll = await fetchOne(SOURCE, { snapshots: [{ content: 'vote', poll: true }] });
    expect(classify(poll, ctx)).toEqual({ kind: 'repost', stays: ['poll'] });
    const buttons = await fetchOne(SOURCE, { snapshots: [{ content: 'x', components: [{ type: 1, components: [linkButton] }] }] });
    expect(classify(buttons, ctx)).toEqual({ kind: 'repost', stays: ['interactive'] });
    const v2 = await fetchOne(SOURCE, { snapshots: [{ content: '', flags: MessageFlags.IsComponentsV2 }] });
    expect(classify(v2, ctx)).toEqual({ kind: 'repost', stays: ['interactive'] });
    const plain = await fetchOne(SOURCE, { snapshots: [{ content: 'x', embeds: [{ type: 'rich', title: 'ok' }] }] });
    expect(classify(plain, ctx)).toEqual({ kind: 'repost', stays: [] });
  });

  it('more than ten embeds stay; a member\'s link previews don\'t count', async () => {
    const rich = (count: number) => Array.from({ length: count }, (_, index) => ({ type: 'rich', title: `e${index}` }));
    expect(classify(await fetchOne(SOURCE, { embeds: rich(10) }), ctx)).toEqual({ kind: 'repost', stays: [] });
    expect(classify(await fetchOne(SOURCE, { embeds: rich(4), snapshots: [{ content: '', embeds: rich(7) }] }), ctx)).toEqual({ kind: 'repost', stays: ['embeds'] });
    const previews = Array.from({ length: 11 }, (_, index) => ({ type: 'link', url: `https://x.test/${index}` }));
    expect(classify(await fetchOne(SOURCE, { authorId: MEMBER, embeds: previews }), ctx)).toEqual({ kind: 'repost', stays: [] });
  });

  it('embeds showing more than ten files, or a file name that can\'t be read, stay', async () => {
    const link = (index: number) => `https://cdn.discordapp.com/attachments/${SOURCE}/1000000000000006${String(index).padStart(2, '0')}/p${index}.png`;
    const embeds = (count: number) => Array.from({ length: count }, (_, index) => ({ type: 'rich', image: { url: link(index) } }));
    expect(classify(await fetchOne(SOURCE, { embeds: embeds(10) }), ctx)).toEqual({ kind: 'repost', stays: [] });
    const many = [...embeds(10).slice(0, 9), { type: 'rich', image: { url: link(9) }, thumbnail: { url: link(10) } }];
    expect(classify(await fetchOne(SOURCE, { embeds: many }), ctx)).toEqual({ kind: 'repost', stays: ['too-large'] });
    const bad = [{ type: 'rich', image: { url: `https://cdn.discordapp.com/attachments/${SOURCE}/100000000000000600/%E0%A4%A.png` } }];
    expect(classify(await fetchOne(SOURCE, { embeds: bad }), ctx)).toEqual({ kind: 'repost', stays: ['too-large'] });
  });

  it('sticky posts stay', async () => {
    const message = await fetchOne(SOURCE, { content: 'sticky' });
    expect(classify(message, { ...ctx, isSticky: (m) => m.id === message.id })).toEqual({ kind: 'repost', stays: ['interactive'] });
  });

  it('oversized files stay, and reasons combine', async () => {
    const files = [{ filename: 'big.bin', data: 'x'.repeat(101) }];
    const message = await fetchOne(SOURCE, { files, poll: true, threadId: THREAD, flags: MessageFlags.HasThread });
    expect(classify(message, ctx)).toEqual({ kind: 'repost', stays: ['too-large', 'poll', 'thread'] });
  });

  it('total above the limit stays', async () => {
    const files = [{ filename: 'a.bin', data: 'x'.repeat(60) }, { filename: 'b.bin', data: 'x'.repeat(60) }];
    expect(classify(await fetchOne(SOURCE, { files }), ctx)).toEqual({ kind: 'repost', stays: ['too-large'] });
  });
});
