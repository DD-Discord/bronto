import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, Events, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forums, templateImages, templates } from '../src/db/schema.js';
import { FORUM, GUILD, prepareTemplatesBot, ready, stallDownloads, templatesDb, USER, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;

const OTHER_FORUM = '100000000000000020';
const TEXT = '100000000000000030';
const STAFF = '100000000000000031';
const MEMBER = '100000000000000098';
let nextId = 100000000000007000n;
const id = () => String(++nextId);

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  tb = await prepareTemplatesBot(t, discord);
  discord.addChannel(OTHER_FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  discord.addChannel(TEXT, { guildId: GUILD, type: ChannelType.GuildText });
  discord.addChannel(STAFF, {
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionOverwrites: [{ id: GUILD, type: OverwriteType.Role, allow: '0', deny: String(PermissionFlagsBits.ViewChannel) }],
  });
  discord.addMember(GUILD, USER);
  discord.addMember(GUILD, MEMBER);
  await templatesDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
  await ready(tb);
  // The gateway caches channels with the Guilds intent; the fake has no gateway.
  for (const forum of [FORUM, OTHER_FORUM]) await tb.client.channels.fetch(forum);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tb.bot.stop();
  await t.drop();
});

const stored = () => t.database.admin.select().from(templates);

/** A post by a user with `body` as its starter message; the gateway event is emitted for it. */
async function userPost(body: string, options: { forum?: string; ownerId?: string; newlyCreated?: boolean } = {}) {
  const threadId = id();
  const ownerId = options.ownerId ?? USER;
  discord.addChannel(threadId, { guildId: GUILD, type: ChannelType.PublicThread, parentId: options.forum ?? FORUM, ownerId, name: 'My post' });
  discord.addMessage(threadId, threadId, { content: body, authorId: ownerId });
  const thread = await tb.client.channels.fetch(threadId);
  tb.client.emit(Events.ThreadCreate, thread, options.newlyCreated ?? true);
  await tb.bot.idle();
  return threadId;
}

const replies = (threadId: string) =>
  tb.requests.filter((request) => request.method === 'POST' && request.path === `/channels/${threadId}/messages`);

describe('new posts', () => {
  it('turns a text body into a template and deletes the user post', async () => {
    const threadId = await userPost('Welcome everyone');
    const [row] = await stored();
    expect(row).toMatchObject({ name: 'My post', content: 'Welcome everyone', embed: null });
    expect(row!.threadId).not.toBe(threadId);
    expect(discord.channels.has(threadId)).toBe(false);
    expect(discord.channels.get(row!.threadId)).toMatchObject({ parent_id: FORUM, owner_id: discord.botId });
  });

  it('imports a JSON body', async () => {
    const threadId = await userPost('```json\n{"content":"Hi","embeds":[{"title":"Rules","description":"Be kind"}]}\n```');
    const [row] = await stored();
    expect(row).toMatchObject({ name: 'My post', content: 'Hi', embed: { title: 'Rules', description: 'Be kind' } });
    expect(discord.channels.has(threadId)).toBe(false);
  });

  it('imports a linked message with its Discord-hosted images as uploads', async () => {
    const source = id();
    const file = discord.addFile(TEXT, { filename: 'pic.png', data: 'png bytes' });
    discord.addMessage(TEXT, source, {
      content: 'Linked text',
      embeds: [{ title: 'Linked', image: { url: file.url }, thumbnail: { url: 'https://example.test/thumb.png' } }],
    });
    await userPost(`https://discord.com/channels/${GUILD}/${TEXT}/${source}`);

    const [row] = await stored();
    expect(row).toMatchObject({
      content: 'Linked text',
      embed: { title: 'Linked', image: { url: 'attachment://image.png' }, thumbnail: { url: 'https://example.test/thumb.png' } },
    });
    const [image] = await t.database.admin.select().from(templateImages);
    expect(image).toMatchObject({ templateId: row!.id, slot: 'image' });
    const preview = discord.messages.get(row!.previewMessageId)!;
    expect(preview.attachments.map((attachment) => attachment.filename)).toEqual(['image.png']);
    expect(Buffer.from(discord.files.get(preview.attachments[0]!.id)!.data).toString()).toBe('png bytes');
  });

  it('refuses a link to another server and keeps the post', async () => {
    const other = '100000000000000555';
    const threadId = await userPost(`https://discord.com/channels/${other}/${TEXT}/${id()}`);
    expect(await stored()).toHaveLength(0);
    expect(discord.channels.has(threadId)).toBe(true);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toBe(
      "I couldn't turn this post into a template: The message link must point to this server.",
    );
  });

  it('refuses a link to a channel the poster cannot read and keeps the post', async () => {
    const source = id();
    discord.addMessage(STAFF, source, { content: 'Staff only' });
    const threadId = await userPost(`https://discord.com/channels/${GUILD}/${STAFF}/${source}`, { ownerId: MEMBER });
    expect(await stored()).toHaveLength(0);
    expect(discord.channels.has(threadId)).toBe(true);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toBe(
      "I couldn't turn this post into a template: You can only import messages you can read.",
    );
  });

  it('answers a failed image download in the post', async () => {
    const source = id();
    discord.addMessage(TEXT, source, {
      embeds: [{ title: 'Gone', image: { url: 'https://cdn.discordapp.com/attachments/1/2/missing.png' } }],
    });
    const threadId = await userPost(`https://discord.com/channels/${GUILD}/${TEXT}/${source}`);
    expect(await stored()).toHaveLength(0);
    expect(discord.channels.has(threadId)).toBe(true);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toBe(
      "I couldn't turn this post into a template: I couldn't download an image from that message.",
    );
  });

  it('answers an image download that times out like a failed one', async () => {
    const source = id();
    const file = discord.addFile(TEXT, { filename: 'pic.png', data: 'png bytes' });
    discord.addMessage(TEXT, source, { embeds: [{ title: 'Slow', image: { url: file.url } }] });
    stallDownloads();
    const threadId = await userPost(`https://discord.com/channels/${GUILD}/${TEXT}/${source}`);
    expect(await stored()).toHaveLength(0);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toBe(
      "I couldn't turn this post into a template: I couldn't download an image from that message.",
    );
  });

  it('refuses a linked image over 25 MB', async () => {
    const source = id();
    const file = discord.addFile(TEXT, { filename: 'huge.png', data: Buffer.alloc(25 * 1024 * 1024 + 1) });
    discord.addMessage(TEXT, source, { embeds: [{ title: 'Huge', image: { url: file.url } }] });
    const threadId = await userPost(`https://discord.com/channels/${GUILD}/${TEXT}/${source}`);
    expect(await stored()).toHaveLength(0);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toBe(
      "I couldn't turn this post into a template: I couldn't download an image from that message.",
    );
  });

  it('replies and keeps the post when the template is invalid', async () => {
    const threadId = await userPost(JSON.stringify({ embeds: [{ description: 'x'.repeat(7000) }] }));
    expect(await stored()).toHaveLength(0);
    expect(discord.channels.has(threadId)).toBe(true);
    expect(replies(threadId)).toHaveLength(1);
    expect(discord.messages.get(lastMessageId(threadId))?.content).toMatch(/^I couldn't turn this post into a template: /);
  });

  it('ignores the bot\'s own posts, other forums and old threads', async () => {
    const own = await userPost('Own', { ownerId: discord.botId });
    const elsewhere = await userPost('Elsewhere', { forum: OTHER_FORUM });
    const old = await userPost('Old', { newlyCreated: false });
    expect(await stored()).toHaveLength(0);
    for (const threadId of [own, elsewhere, old]) {
      expect(discord.channels.has(threadId)).toBe(true);
      expect(replies(threadId)).toHaveLength(0);
    }
  });

  it('keeps the template and logs when the user post cannot be deleted', async () => {
    discord.override('DELETE', `/channels/${nextId + 1n}`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    await userPost('Stays');
    expect(await stored()).toHaveLength(1);
    expect(tb.lines.some((line) => line.level === 40)).toBe(true);
  });
});

function lastMessageId(threadId: string): string {
  const ids = [...discord.messages.values()].filter((message) => message.channel_id === threadId && message.id !== threadId);
  return ids[ids.length - 1]!.id;
}
