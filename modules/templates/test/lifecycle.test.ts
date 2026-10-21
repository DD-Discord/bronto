import { defineModule, on } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forums, templates } from '../src/db/schema.js';
import { templatesEvents } from '../src/events.js';
import { createTemplatesModule } from '../src/index.js';
import { FORUM, GUILD, prepareTemplatesBot, ready, templatesDb, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;
let emitted: string[];

const watcher = defineModule({
  name: 'watcher',
  dependsOn: [createTemplatesModule()],
  listeners: [on(templatesEvents.deleted, (_ctx, { id }) => void emitted.push(id))],
});

const THREAD_A = '100000000000008001';
const THREAD_B = '100000000000008002';
const THIRD = '100000000000008004';
const OTHER_THREAD = '100000000000008003';

function addPost(threadId: string, name: string) {
  discord.addChannel(threadId, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM, name });
}

async function seed(threadId: string, name: string) {
  addPost(threadId, name);
  const [row] = await templatesDb(t).run(async (tx) =>
    tx.insert(templates).values({ name, threadId, previewMessageId: '1' }).returning(),
  );
  return row!;
}

async function bootstrap() {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  emitted = [];
  tb = await prepareTemplatesBot(t, discord, { extra: [{ packageName: '@test/watcher', definition: watcher, config: {} }] });
  await templatesDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
  await seed(THREAD_A, 'Alpha');
  await seed(THREAD_B, 'Beta');
}

beforeEach(() => {
  t = undefined as never;
});

afterEach(async () => {
  await tb?.bot.stop();
  await t?.drop();
});

const rows = () => t.database.admin.select().from(templates);
const forumRows = () => t.database.admin.select().from(forums);

function rawThreadDelete(id: string, parentId = FORUM) {
  tb.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id, guild_id: GUILD, parent_id: parentId, type: 11 }, s: 1 }, 0);
}

describe('deletions and renames', () => {
  beforeEach(async () => {
    await bootstrap();
    await ready(tb);
  });

  it('deletes the template of a deleted post', async () => {
    rawThreadDelete(THREAD_A);
    await tb.bot.idle();
    const left = await rows();
    expect(emitted).toHaveLength(1);
    expect(left.map((row) => row.threadId)).toEqual([THREAD_B]);
    expect(tb.lines.some((line) => line.level === 30 && line.msg === 'Template deleted' && typeof line.templateId === 'string' && line.threadId === THREAD_A && line.name === 'Alpha')).toBe(true);
  });

  it('ignores other threads', async () => {
    rawThreadDelete(OTHER_THREAD);
    await tb.bot.idle();
    expect(await rows()).toHaveLength(2);
  });

  it('deletes all templates and the forum row when the forum is deleted', async () => {
    const forum = await tb.client.channels.fetch(FORUM);
    tb.client.emit(Events.ChannelDelete, forum as never);
    await tb.bot.idle();
    expect(await rows()).toHaveLength(0);
    expect(await forumRows()).toHaveLength(0);
    expect(emitted).toHaveLength(2);
  });

  it('ignores the deletion of another channel', async () => {
    discord.addChannel('100000000000008100', { guildId: GUILD, type: ChannelType.GuildForum });
    const other = await tb.client.channels.fetch('100000000000008100');
    tb.client.emit(Events.ChannelDelete, other as never);
    await tb.bot.idle();
    expect(await rows()).toHaveLength(2);
    expect(await forumRows()).toHaveLength(1);
  });

  it('renames the template when its post is renamed', async () => {
    const before = (await tb.client.channels.fetch(THREAD_A)) as never as { name: string };
    const after = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { name: 'Gamma' });
    tb.client.emit(Events.ThreadUpdate, before as never, after as never);
    await tb.bot.idle();
    expect((await rows()).find((row) => row.threadId === THREAD_A)!.name).toBe('Gamma');
    expect((await rows()).find((row) => row.threadId === THREAD_B)!.name).toBe('Beta');
  });

  it('ignores renames of other threads', async () => {
    addPost(OTHER_THREAD, 'Other');
    const thread = (await tb.client.channels.fetch(OTHER_THREAD)) as never as { name: string };
    const after = Object.assign(Object.create(Object.getPrototypeOf(thread)), thread, { name: 'Renamed' });
    tb.client.emit(Events.ThreadUpdate, thread as never, after as never);
    await tb.bot.idle();
    expect((await rows()).map((row) => row.name).sort()).toEqual(['Alpha', 'Beta']);
  });
});

describe('reconcile at start-up', () => {
  it('deletes templates whose post is gone', async () => {
    await bootstrap();
    discord.channels.delete(THREAD_A);
    await ready(tb);
    expect((await rows()).map((row) => row.threadId)).toEqual([THREAD_B]);
  });

  it('deletes everything when the forum is gone', async () => {
    await bootstrap();
    discord.channels.delete(FORUM);
    discord.channels.delete(THREAD_A);
    discord.channels.delete(THREAD_B);
    await ready(tb);
    expect(await rows()).toHaveLength(0);
    expect(await forumRows()).toHaveLength(0);
  });

  it('keeps everything when Discord answers Missing Access', async () => {
    await bootstrap();
    discord.override('GET', `/channels/${THREAD_A}`, () => ({ status: 403, json: { code: 50001, message: 'Missing Access' } }));
    await ready(tb);
    expect(await rows()).toHaveLength(2);
    expect(tb.lines.some((line) => line.level === 40 && line.threadId === THREAD_A)).toBe(true);
  });

  it('keeps everything when Discord fails', async () => {
    await bootstrap();
    discord.override('GET', `/channels/${FORUM}`, () => ({ status: 500, json: { message: 'oops' } }));
    discord.override('GET', `/channels/${THREAD_B}`, () => ({ status: 500, json: { message: 'oops' } }));
    discord.channels.delete(THREAD_A);
    await ready(tb);
    // The forum check failed, so nothing is touched.
    expect(tb.lines.some((line) => line.level === 40 && line.msg === 'Checking the template forum failed' && line.channelId === FORUM)).toBe(true);
    expect(await rows()).toHaveLength(2);
    expect(await forumRows()).toHaveLength(1);
  });

  it('removes only the deleted post when other posts fail to answer', async () => {
    await bootstrap();
    await seed(THIRD, 'Gamma');
    discord.override('GET', `/channels/${THREAD_A}`, () => ({ status: 500, json: { message: 'oops' } }));
    discord.override('GET', `/channels/${THREAD_B}`, () => ({ status: 403, json: { code: 50001, message: 'Missing Access' } }));
    discord.channels.delete(THIRD);
    await ready(tb);
    expect((await rows()).map((row) => row.threadId).sort()).toEqual([THREAD_A, THREAD_B]);
    expect(await forumRows()).toHaveLength(1);
    const warned = tb.lines.filter((line) => line.level === 40 && line.msg === 'Checking a template post failed');
    expect(warned.map((line) => line.threadId).sort()).toEqual([THREAD_A, THREAD_B]);
    expect(warned.every((line) => typeof line.templateId === 'string' && line.err !== undefined)).toBe(true);
    expect(tb.lines.filter((line) => line.level === 30 && line.msg === 'Template deleted' && line.threadId === THIRD)).toHaveLength(1);
  });
});
