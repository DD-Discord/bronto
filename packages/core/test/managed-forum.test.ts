import { ChannelType, Events, OverwriteType, PermissionFlagsBits, type AnyThreadChannel } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertGuild } from '../src/db/guilds.js';
import { defineManagedForum, type ManagedForum, type ManagedForumOptions } from '../src/forums/managed-forum.js';
import { UserError } from '../src/interactions/errors.js';
import { createBot, type Bot } from '../src/runtime/bot.js';
import type { HandlerContext } from '../src/runtime/types.js';
import { FakeDiscordHttp } from '../src/testing/discord-http.js';
import { TEST_INTERACTION_SECRET } from '../src/testing/index.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { createNativeTestClient, type NativeTestClient } from '../src/testing/native-client.js';
import type { RecordedRequest } from '../src/testing/rest.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetForums, widgetPosts } from './fixtures/widgets/schema.js';
import { createTestDatabase, widgetsDb, type TestDatabase } from './test-db.js';

// Made-up IDs; tests never use real server data.
const GUILD = '100000000000000001';
const FORUM = '100000000000000010';
const OTHER_FORUM = '100000000000000020';
const NEW_FORUM = '100000000000000030';
const THREAD_A = '100000000000008001';
const THREAD_B = '100000000000008002';
const USER = '100000000000000099';
let nextId = 100000000000007000n;
const id = () => String(++nextId);

type Options = Partial<ManagedForumOptions<typeof widgetPosts, any>>;

let t: TestDatabase;
let discord: FakeDiscordHttp;
let native: NativeTestClient;
let bot: Bot;
let lines: LogLine[];
let requests: RecordedRequest[];
let forum: ManagedForum<typeof widgetPosts>;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await bot?.stop();
  bot = undefined as never;
  await t.drop();
});

/** A post's record as `createFromPost` stores it, with a new bot-owned thread ID. */
async function insertRecord(ctx: HandlerContext, name: string): Promise<void> {
  await ctx.db.run(async (tx) => {
    await tx.insert(widgetPosts).values({ name, threadId: id() });
  });
}

/** A bot with a widgets module built around a managed forum; database migrated, GUILD registered, not yet ready. */
async function prepare(options: Options = {}, guild: { community?: boolean } = {}): Promise<void> {
  forum = defineManagedForum({
    forumName: 'widgets',
    tables: { forums: widgetForums, records: widgetPosts },
    wording: { noun: 'widget', forumLabel: 'widget forum', logKey: 'widgetId' },
    createFromPost: (ctx, thread) => insertRecord(ctx, thread.name),
    ...options,
  });
  discord.addGuild(GUILD, { community: guild.community ?? true });
  discord.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  discord.addChannel(OTHER_FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  native = await createNativeTestClient(discord);
  requests = native.requests;
  const captured = captureLog();
  lines = captured.lines;
  const definition = widgetsModule({
    listeners: forum.listeners,
    hooks: {
      guildReady: (ctx) => {
        void ctx.queue.run('reconcile', (task) => forum.reconcile(task));
      },
    },
  });
  bot = createBot({
    config: {
      discord: { token: 'token' },
      database: { appUrl: t.appUrl, adminUrl: t.adminUrl },
      modules: {},
      interactions: { secret: TEST_INTERACTION_SECRET },
    },
    modules: [{ packageName: '@test/widgets', definition, config: {} }],
    database: t.database,
    client: native.client,
    log: captured.log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
}

/** Logs in and runs the start-up work, including the queued reconcile. */
async function ready(): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Stores FORUM and a record for each post, which exist in Discord. */
async function seed(): Promise<void> {
  await widgetsDb(t.database, GUILD).run(async (tx) => {
    await tx.insert(widgetForums).values({ forumChannelId: FORUM });
  });
  for (const [threadId, name] of [[THREAD_A, 'Alpha'], [THREAD_B, 'Beta']] as const) {
    discord.addChannel(threadId, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM, name });
    await widgetsDb(t.database, GUILD).run(async (tx) => {
      await tx.insert(widgetPosts).values({ name, threadId });
    });
  }
}

/** Runs `fn` as a widgets handler of GUILD and returns its result or rejects with its error. */
async function inHandler<T>(fn: (ctx: HandlerContext) => Promise<T>): Promise<T> {
  const runtime = bot.runtimes.find((entry) => entry.name === 'widgets')!;
  let result: { value: T } | undefined;
  const outcome = await bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
    result = { value: await fn(ctx) };
  });
  if (!outcome.ok) throw outcome.error;
  return result!.value;
}

/** A member's post in `forum`; the gateway event is emitted for it. */
async function memberPost(options: { forum?: string; ownerId?: string; newlyCreated?: boolean } = {}): Promise<string> {
  const threadId = id();
  const ownerId = options.ownerId ?? USER;
  // The gateway caches channels with the Guilds intent; the fake has no gateway.
  await native.client.channels.fetch(options.forum ?? FORUM);
  discord.addChannel(threadId, { guildId: GUILD, type: ChannelType.PublicThread, parentId: options.forum ?? FORUM, ownerId, name: 'My post' });
  discord.addMessage(threadId, threadId, { content: 'Body', authorId: ownerId });
  const thread = await native.client.channels.fetch(threadId);
  native.client.emit(Events.ThreadCreate, thread as AnyThreadChannel, options.newlyCreated ?? true);
  await bot.idle();
  return threadId;
}

function rawThreadDelete(threadId: string): void {
  native.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id: threadId, guild_id: GUILD, parent_id: FORUM, type: 11 }, s: 1 }, 0);
}

/** Emits ThreadUpdate for `threadId` renamed to `name`. */
async function rename(threadId: string, name: string): Promise<void> {
  const before = (await native.client.channels.fetch(threadId)) as AnyThreadChannel;
  const after = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { name }) as AnyThreadChannel;
  native.client.emit(Events.ThreadUpdate, before, after);
  await bot.idle();
}

const records = () => t.database.admin.select().from(widgetPosts).orderBy(widgetPosts.name);
const forumRows = () => t.database.admin.select().from(widgetForums);
const channelCreates = () => requests.filter((request) => request.method === 'POST' && request.path === `/guilds/${GUILD}/channels`);
const replies = (threadId: string) => [...discord.messages.values()].filter((message) => message.channel_id === threadId && message.id !== threadId);
const deletedLines = () => lines.filter((line) => line.level === 30 && line.msg === 'Widget deleted');

describe('ensure', () => {
  it('ensure creates a hidden forum and stores it', async () => {
    await prepare();
    await ready();
    const created = await inHandler((ctx) => forum.ensure(ctx));
    const [create] = channelCreates();
    expect(create!.body).toMatchObject({
      name: 'widgets',
      type: ChannelType.GuildForum,
      permission_overwrites: [
        { id: GUILD, type: OverwriteType.Role, deny: String(PermissionFlagsBits.ViewChannel) },
        { id: discord.botId, type: OverwriteType.Member, allow: String(PermissionFlagsBits.ViewChannel) },
      ],
    });
    expect(discord.channels.get(created)?.type).toBe(ChannelType.GuildForum);
    expect((await forumRows()).map((row) => row.forumChannelId)).toEqual([created]);
    expect(await inHandler((ctx) => forum.storedId(ctx))).toBe(created);
  });

  it('ensure returns the stored forum while it exists', async () => {
    await prepare();
    await seed();
    await ready();
    expect(await inHandler((ctx) => forum.ensure(ctx))).toBe(FORUM);
    expect(channelCreates()).toEqual([]);
    expect(await inHandler((ctx) => forum.channelExists(ctx, FORUM))).toBe(true);
    expect(await inHandler((ctx) => forum.channelExists(ctx, NEW_FORUM))).toBe(false);
  });

  it('ensure explains that forums need a Community server', async () => {
    await prepare({}, { community: false });
    await ready();
    const error = await inHandler((ctx) => forum.ensure(ctx)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toBe('Forum channels need a Community server. Turn on Community in Server Settings first.');
    expect(channelCreates()).toEqual([]);
    expect(await forumRows()).toEqual([]);
  });
});

describe('createFromPost', () => {
  it('createFromPost turns a member post into a record and deletes the post', async () => {
    await prepare();
    await seed();
    await ready();
    const threadId = await memberPost();
    expect((await records()).map((row) => row.name)).toEqual(['Alpha', 'Beta', 'My post']);
    expect(discord.channels.has(threadId)).toBe(false);
    expect(replies(threadId)).toEqual([]);
  });

  it("createFromPost ignores posts outside the forum, old posts and the bot's own posts", async () => {
    const calls: string[] = [];
    await prepare({ createFromPost: async (_ctx, thread) => void calls.push(thread.id) });
    await seed();
    await ready();
    const posts = [
      await memberPost({ forum: OTHER_FORUM }),
      await memberPost({ newlyCreated: false }),
      await memberPost({ ownerId: discord.botId }),
    ];
    expect(calls).toEqual([]);
    for (const threadId of posts) {
      expect(discord.channels.has(threadId)).toBe(true);
      expect(replies(threadId)).toEqual([]);
    }
  });

  it('createFromPost UserErrors reply in the post, which stays', async () => {
    await prepare({
      createFromPost: async () => {
        throw new UserError('Widgets need a <@&1> body.');
      },
    });
    await seed();
    await ready();
    const threadId = await memberPost();
    expect(discord.channels.has(threadId)).toBe(true);
    expect(replies(threadId).map((message) => message.content)).toEqual(["I couldn't turn this post into a widget: Widgets need a <@&1> body."]);
    const send = requests.find((request) => request.method === 'POST' && request.path === `/channels/${threadId}/messages`);
    expect(send!.body).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(lines.filter((line) => line.level >= 50)).toEqual([]);
  });

  it('createFromPost errors reply and rethrow', async () => {
    await prepare({
      createFromPost: async () => {
        throw new Error('boom');
      },
    });
    await seed();
    await ready();
    const threadId = await memberPost();
    expect(discord.channels.has(threadId)).toBe(true);
    const [reply] = replies(threadId);
    expect(reply!.content).toBe("I couldn't turn this post into a widget: Something went wrong.");
    const failed = lines.filter((line) => line.level === 50 && line.msg === 'Handler failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.err as { message?: string }).message).toBe('boom');
  });

  it('createFromPost skip leaves the post alone', async () => {
    await prepare({ createFromPost: async () => 'skip' });
    await seed();
    await ready();
    const threadId = await memberPost();
    expect(discord.channels.has(threadId)).toBe(true);
    expect(replies(threadId)).toEqual([]);
    expect(requests.filter((request) => request.method === 'DELETE' && request.path === `/channels/${threadId}`)).toEqual([]);
  });

  it('createFromPost warns when the post cannot be deleted', async () => {
    await prepare();
    await seed();
    await ready();
    discord.override('DELETE', `/channels/${nextId + 1n}`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    const threadId = await memberPost();
    expect((await records()).map((row) => row.name)).toContain('My post');
    expect(discord.channels.has(threadId)).toBe(true);
    expect(lines.some((line) => line.level === 40 && line.msg === "Deleting the member's post after creating its widget failed" && line.threadId === threadId)).toBe(true);
  });
});

describe('deletions', () => {
  it('a deleted post forgets its record', async () => {
    const forgot: string[] = [];
    await prepare({ forgotOne: (_ctx, record) => void forgot.push(record.threadId) });
    await seed();
    await ready();
    rawThreadDelete(THREAD_A);
    await bot.idle();
    expect((await records()).map((row) => row.threadId)).toEqual([THREAD_B]);
    expect(forgot).toEqual([THREAD_A]);
    const [line] = deletedLines();
    expect(deletedLines()).toHaveLength(1);
    expect(line).toMatchObject({ name: 'Alpha', threadId: THREAD_A });
    expect(typeof line!.widgetId).toBe('string');

    rawThreadDelete(id());
    await bot.idle();
    expect(await records()).toHaveLength(1);
    expect(forgot).toHaveLength(1);
  });

  it('forget returns whether a record was deleted', async () => {
    await prepare();
    await seed();
    await ready();
    const [alpha] = await records();
    expect(await inHandler((ctx) => forum.forget(ctx, alpha!))).toBe(true);
    expect(await inHandler((ctx) => forum.forget(ctx, alpha!))).toBe(false);
  });

  it('forgetOne replaces the default delete', async () => {
    const forgotten: string[] = [];
    const forgot: string[] = [];
    await prepare({
      forgetOne: async (ctx, record) => {
        forgotten.push(record.name);
        await ctx.db.run(async (tx) => {
          await tx.update(widgetPosts).set({ name: 'Kept' }).where(eq(widgetPosts.id, record.id));
        });
        return 'custom';
      },
      forgotOne: (_ctx, record) => void forgot.push(record.name),
    });
    await seed();
    await ready();
    rawThreadDelete(THREAD_A);
    await bot.idle();
    expect(forgotten).toEqual(['Alpha']);
    expect((await records()).map((row) => row.name)).toEqual(['Beta', 'Kept']);
    expect(deletedLines()).toEqual([]);
    expect(forgot).toEqual([]);
    const [beta] = await records();
    expect(await inHandler((ctx) => forum.forget(ctx, beta!))).toBe('custom');
  });

  it('a deleted forum forgets all records', async () => {
    const forgotAll: Array<{ names: string[]; extra: unknown }> = [];
    await prepare({
      forgetAllTx: async (tx) => (await tx.select().from(widgetPosts)).length,
      forgotAll: (_ctx, gone, extra) => void forgotAll.push({ names: gone.map((record) => record.name).sort(), extra }),
    });
    await seed();
    await ready();
    native.client.emit(Events.ChannelDelete, (await native.client.channels.fetch(FORUM)) as never);
    await bot.idle();
    expect(await records()).toEqual([]);
    expect(await forumRows()).toEqual([]);
    expect(forgotAll).toEqual([{ names: ['Alpha', 'Beta'], extra: 2 }]);
    expect(deletedLines().map((line) => line.threadId).sort()).toEqual([THREAD_A, THREAD_B]);
  });

  it('a deleted channel other than the forum keeps everything', async () => {
    await prepare();
    await seed();
    await ready();
    native.client.emit(Events.ChannelDelete, (await native.client.channels.fetch(OTHER_FORUM)) as never);
    await bot.idle();
    expect(await records()).toHaveLength(2);
    expect(await forumRows()).toHaveLength(1);
  });

  it('forgetForum does nothing once another forum is stored', async () => {
    const forgotAll: unknown[] = [];
    let ranTx = false;
    await prepare({
      forgetAllTx: async () => {
        ranTx = true;
      },
      forgotAll: (_ctx, gone) => void forgotAll.push(gone),
    });
    await seed();
    const NEW_THREAD = id();
    discord.channels.delete(FORUM);
    // Answers only after a new forum and record were stored, as `ensure` does meanwhile.
    discord.override('GET', `/channels/${FORUM}`, async () => {
      discord.addChannel(NEW_FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
      discord.addChannel(NEW_THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: NEW_FORUM, name: 'New' });
      await widgetsDb(t.database, GUILD).run(async (tx) => {
        await tx.update(widgetForums).set({ forumChannelId: NEW_FORUM });
        await tx.insert(widgetPosts).values({ name: 'New', threadId: NEW_THREAD });
      });
      return { status: 404, json: { code: 10003, message: 'Unknown Channel' } };
    });
    await ready();
    expect((await forumRows()).map((row) => row.forumChannelId)).toEqual([NEW_FORUM]);
    expect((await records()).map((row) => row.threadId)).toContain(NEW_THREAD);
    expect(ranTx).toBe(false);
    expect(forgotAll).toEqual([]);
    expect(deletedLines()).toEqual([]);
  });
});

describe('renames', () => {
  it('a renamed post renames its record', async () => {
    await prepare();
    await seed();
    await ready();
    await rename(THREAD_A, 'Gamma');
    expect((await records()).map((row) => [row.threadId, row.name])).toEqual([[THREAD_B, 'Beta'], [THREAD_A, 'Gamma']]);
  });

  it('rename replaces the default rename', async () => {
    const renamed: string[] = [];
    await prepare({ rename: async (_ctx, thread) => void renamed.push(`${thread.id}:${thread.name}`) });
    await seed();
    await ready();
    await rename(THREAD_A, 'Gamma');
    expect(renamed).toEqual([`${THREAD_A}:Gamma`]);
    expect((await records()).map((row) => row.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('reconcile', () => {
  it('reconcile forgets records whose posts are gone', async () => {
    const forgot: string[] = [];
    await prepare({ forgotOne: (_ctx, record) => void forgot.push(record.threadId) });
    await seed();
    discord.channels.delete(THREAD_A);
    await ready();
    expect((await records()).map((row) => row.threadId)).toEqual([THREAD_B]);
    expect(forgot).toEqual([THREAD_A]);
    expect(deletedLines().map((line) => line.threadId)).toEqual([THREAD_A]);
  });

  it('reconcile forgets everything when the forum is gone', async () => {
    let gone: string[] = [];
    await prepare({ forgotAll: (_ctx, records) => void (gone = records.map((record) => record.name).sort()) });
    await seed();
    discord.channels.delete(FORUM);
    await ready();
    expect(await records()).toEqual([]);
    expect(await forumRows()).toEqual([]);
    expect(gone).toEqual(['Alpha', 'Beta']);
  });

  it('reconcile keeps data when a check fails', async () => {
    await prepare();
    await seed();
    discord.override('GET', `/channels/${FORUM}`, () => ({ status: 500, json: { message: 'oops' } }));
    discord.channels.delete(THREAD_A);
    await ready();
    expect(lines.some((line) => line.level === 40 && line.msg === 'Checking the widget forum failed' && line.channelId === FORUM && line.err !== undefined)).toBe(true);
    expect(await records()).toHaveLength(2);
    expect(await forumRows()).toHaveLength(1);

    discord.clearOverride('GET', `/channels/${FORUM}`);
    discord.addChannel(THREAD_A, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM, name: 'Alpha' });
    discord.override('GET', `/channels/${THREAD_A}`, () => ({ status: 403, json: { code: 50001, message: 'Missing Access' } }));
    discord.channels.delete(THREAD_B);
    await inHandler((ctx) => forum.reconcile(ctx));
    const warned = lines.filter((line) => line.level === 40 && line.msg === 'Checking a widget post failed');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ threadId: THREAD_A });
    expect(typeof warned[0]!.widgetId).toBe('string');
    expect((await records()).map((row) => row.threadId)).toEqual([THREAD_A]);
  });
});
