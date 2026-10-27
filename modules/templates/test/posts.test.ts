import { FakeDiscordHttp } from '@bronto/core/testing';
import { ComponentType, type APIActionRowComponent, type APIButtonComponentWithCustomId } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { templatesApi } from '../src/api.js';
import { forums, templateImages, templates } from '../src/db/schema.js';
import { linkExpiry } from '@bronto/core';
import { createPost, updatePreview } from '../src/posts.js';
import { FORUM, GUILD, inHandler, prepareTemplatesBot, templatesDb, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  tb = await prepareTemplatesBot(t, discord);
  await templatesDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
});

afterEach(async () => {
  await tb.bot.stop();
  await t.drop();
});

const storedTemplates = () => t.database.admin.select().from(templates);
const storedImages = () => t.database.admin.select().from(templateImages);
const threadCreates = () => tb.requests.filter((request) => request.method === 'POST' && request.path === `/channels/${FORUM}/threads`);

function buttons(messageId: string): APIButtonComponentWithCustomId[] {
  const rows = discord.messages.get(messageId)!.components as APIActionRowComponent<APIButtonComponentWithCustomId>[];
  expect(rows).toHaveLength(1);
  return rows[0]!.components;
}

describe('create', () => {
  it('posts and stores the template', async () => {
    const embed = { title: 'Welcome', description: 'Read the rules.' };
    const { id } = await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'welcome', content: 'Hello @everyone', embed }));

    const [row] = await storedTemplates();
    expect(row).toMatchObject({ id, name: 'welcome', content: 'Hello @everyone', embed, showPostTime: false });
    const thread = discord.channels.get(row!.threadId)!;
    expect(thread).toMatchObject({ name: 'welcome', parent_id: FORUM, guild_id: GUILD });
    expect(row!.previewMessageId).toBe(row!.threadId);

    const preview = discord.messages.get(row!.previewMessageId)!;
    expect(preview).toMatchObject({ content: 'Hello @everyone', embeds: [embed], allowed_mentions: { parse: [] } });
    const row0 = buttons(preview.id);
    expect(row0.map((button) => [button.type, button.label])).toEqual([
      [ComponentType.Button, 'Edit'],
      [ComponentType.Button, 'Export'],
      [ComponentType.Button, 'Import'],
      [ComponentType.Button, 'Delete'],
    ]);
    expect(row0.map((button) => button.custom_id.split(':').slice(0, 2).join(':'))).toEqual([
      'templates:edit',
      'templates:export',
      'templates:import',
      'templates:delete',
    ]);

    const api = (fn: (a: ReturnType<typeof templatesApi>) => Promise<unknown>) => inHandler(tb, (ctx) => fn(templatesApi(ctx)));
    expect(await api((a) => a.get(id))).toEqual({ id, name: 'welcome', url: `https://discord.com/channels/${GUILD}/${row!.threadId}` });
    expect(await api((a) => a.render(id))).toEqual({ content: 'Hello @everyone', embed });
  });

  it('truncates the post title to 100 characters', async () => {
    const name = 'n'.repeat(120);
    await inHandler(tb, (ctx) => templatesApi(ctx).create({ name, content: 'Hi', embed: null }));
    const [row] = await storedTemplates();
    expect(row!.name).toBe('n'.repeat(100));
    expect(discord.channels.get(row!.threadId)!.name).toBe('n'.repeat(100));
  });

  it('refuses an invalid template without posting', async () => {
    await expect(inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'empty', content: ' ', embed: null }))).rejects.toThrow(
      'A template needs text or an embed.',
    );
    expect(threadCreates()).toEqual([]);
    expect(await storedTemplates()).toEqual([]);
  });

  it('creates the forum when none is stored', async () => {
    await t.database.admin.delete(forums);
    await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'welcome', content: 'Hi', embed: null }));
    const [forum] = await t.database.admin.select().from(forums);
    expect(forum!.forumChannelId).not.toBe(FORUM);
    const [row] = await storedTemplates();
    expect(discord.channels.get(row!.threadId)!).toMatchObject({ parent_id: forum!.forumChannelId });
  });

  it('with a known id returns it without requests', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(await inHandler(tb, (ctx) => templatesApi(ctx).create({ id, name: 'welcome', content: 'Hi', embed: null }))).toEqual({ id });
    const before = tb.requests.length;
    expect(await inHandler(tb, (ctx) => templatesApi(ctx).create({ id, name: 'other', content: 'Bye', embed: null }))).toEqual({ id });
    expect(tb.requests).toHaveLength(before);
    expect(await storedTemplates()).toMatchObject([{ id, name: 'welcome' }]);
  });

  it('deletes the post when the insert fails', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    await inHandler(tb, (ctx) => createPost(ctx, { id, name: 'first', content: 'Hi', embed: null }));
    await expect(inHandler(tb, (ctx) => createPost(ctx, { id, name: 'second', content: 'Hi', embed: null }))).rejects.toThrow();
    const created = threadCreates();
    expect(created).toHaveLength(2);
    const second = [...discord.channels.values()].find((channel) => (channel as { name?: string }).name === 'second');
    expect(second).toBeUndefined();
    expect(discord.deletedChannels).toHaveLength(1);
    expect(await storedTemplates()).toMatchObject([{ id, name: 'first' }]);
  });

  it('attaches uploads and stores their links', async () => {
    const template = await inHandler(tb, (ctx) =>
      createPost(ctx, {
        name: 'pictures',
        content: '',
        embed: { title: 'Look', author: { name: 'Me' } },
        uploads: [
          { slot: 'image', name: 'Photo.PNG', data: Buffer.from('image-bytes') },
          { slot: 'author_icon', name: 'face.webp', data: Buffer.from('icon-bytes') },
        ],
      }),
    );
    expect(template.embed).toEqual({
      title: 'Look',
      author: { name: 'Me', icon_url: 'attachment://author_icon.webp' },
      image: { url: 'attachment://image.png' },
    });
    const preview = discord.messages.get(template.previewMessageId)!;
    expect(preview.attachments.map((attachment) => attachment.filename).sort()).toEqual(['author_icon.webp', 'image.png']);
    const rows = await storedImages();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const attachment = preview.attachments.find((a) => a.id === row.attachmentId)!;
      expect(attachment.filename.startsWith(row.slot)).toBe(true);
      expect(row).toMatchObject({ templateId: template.id, messageId: template.previewMessageId });
      expect(row.expiresAt.getTime()).toBe(linkExpiry(row.url)!.getTime());
      expect(discord.files.get(row.attachmentId)!.data.toString()).toBe(row.slot === 'image' ? 'image-bytes' : 'icon-bytes');
    }
  });

  it('refuses an icon upload without the text it belongs to', async () => {
    await expect(
      inHandler(tb, (ctx) =>
        createPost(ctx, { name: 'x', content: 'Hi', embed: null, uploads: [{ slot: 'footer_icon', name: 'f.png', data: Buffer.from('f') }] }),
      ),
    ).rejects.toThrow('A footer icon needs footer text.');
    expect(threadCreates()).toEqual([]);
  });
});

describe('search', () => {
  it('matches names case-insensitively, wildcards literally, ordered by name', async () => {
    for (const name of ['Rules', 'welcome', 'Welcome back', '100% done', 'a_b']) {
      await inHandler(tb, (ctx) => templatesApi(ctx).create({ name, content: 'Hi', embed: null }));
    }
    const search = (query: string) => inHandler(tb, (ctx) => templatesApi(ctx).search(query));
    expect((await search('WEL')).map((entry) => entry.name)).toEqual(['welcome', 'Welcome back']);
    expect((await search('%')).map((entry) => entry.name)).toEqual(['100% done']);
    expect((await search('_')).map((entry) => entry.name)).toEqual(['a_b']);
    const all = await search('');
    expect(all).toHaveLength(5);
    expect(all[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('returns at most 25', async () => {
    for (let i = 0; i < 26; i += 1) {
      await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: `t${String(i).padStart(2, '0')}`, content: 'Hi', embed: null }));
    }
    expect(await inHandler(tb, (ctx) => templatesApi(ctx).search('t'))).toHaveLength(25);
  });
});

describe('get', () => {
  it('returns null for unknown and malformed ids', async () => {
    expect(await inHandler(tb, (ctx) => templatesApi(ctx).get('00000000-0000-4000-8000-000000000009'))).toBeNull();
    expect(await inHandler(tb, (ctx) => templatesApi(ctx).get('nope'))).toBeNull();
  });
});

describe('updatePreview', () => {
  it('unarchives an archived post and edits it', async () => {
    const template = await inHandler(tb, (ctx) => createPost(ctx, { name: 'welcome', content: 'Hi', embed: null }));
    const thread = discord.channels.get(template.threadId)! as { thread_metadata: { archived: boolean; locked: boolean } };
    thread.thread_metadata.archived = true;
    thread.thread_metadata.locked = true;
    const [updated] = await templatesDb(t).run(async (tx) =>
      tx.update(templates).set({ content: 'Changed' }).where(eq(templates.id, template.id)).returning(),
    );
    const before = tb.requests.length;
    await inHandler(tb, (ctx) => updatePreview(ctx, updated!));
    const calls = tb.requests.slice(before).filter((request) => request.method === 'PATCH').map((request) => request.path);
    expect(calls).toEqual([
      `/channels/${template.threadId}/messages/${template.previewMessageId}`,
      `/channels/${template.threadId}`,
      `/channels/${template.threadId}/messages/${template.previewMessageId}`,
    ]);
    expect(discord.messages.get(template.previewMessageId)!.content).toBe('Changed');
    expect(thread.thread_metadata).toMatchObject({ archived: false, locked: true });
    expect(buttons(template.previewMessageId)).toHaveLength(4);
  });

  it('replaces uploaded slots and keeps the others', async () => {
    const template = await inHandler(tb, (ctx) =>
      createPost(ctx, {
        name: 'pictures',
        content: '',
        embed: { title: 'Look' },
        uploads: [
          { slot: 'image', name: 'a.png', data: Buffer.from('old-image') },
          { slot: 'thumbnail', name: 't.png', data: Buffer.from('thumb') },
        ],
      }),
    );
    const before = await storedImages();
    const changed = { ...template, embed: { ...template.embed!, image: { url: 'attachment://image.gif' } } };
    await inHandler(tb, (ctx) => updatePreview(ctx, changed, [{ slot: 'image', name: 'b.gif', data: Buffer.from('new-image') }]));

    const preview = discord.messages.get(template.previewMessageId)!;
    expect(preview.attachments.map((attachment) => attachment.filename).sort()).toEqual(['image.gif', 'thumbnail.png']);
    expect(preview.embeds[0]).toMatchObject({ image: { url: 'attachment://image.gif' }, thumbnail: { url: 'attachment://thumbnail.png' } });
    const after = await storedImages();
    const thumbnail = (rows: typeof after) => rows.find((row) => row.slot === 'thumbnail')!;
    const image = after.find((row) => row.slot === 'image')!;
    expect(thumbnail(after).attachmentId).toBe(thumbnail(before).attachmentId);
    expect(image.attachmentId).not.toBe(before.find((row) => row.slot === 'image')!.attachmentId);
    expect(discord.files.get(image.attachmentId)!.data.toString()).toBe('new-image');
    expect(image.url).toContain('/image.gif?');
  });
});
