import { fakeCommand, FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, ComponentType, Events, MessageFlags, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, forums } from '../src/db/schema.js';
import { FORUM, GUILD, formsDb, prepareFormsBot, ready, USER, type FormsBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let fb: FormsBot;

let nextId = 100000000000007000n;
const id = () => String(++nextId);

async function start(options: { community?: boolean; sticky?: boolean } = {}): Promise<void> {
  fb = await prepareFormsBot(t, discord, options);
  await ready(fb);
}

async function command(subcommand: string): Promise<string[]> {
  const fake = fakeCommand({ command: 'forms', subcommand, guildId: GUILD, channelId: FORUM, userId: USER, options: {} });
  fb.client.emit(Events.InteractionCreate, fake);
  await fb.bot.idle();
  return fake.responses.map((response) => (response.payload as { content?: string }).content ?? '');
}

const storedForms = () => t.database.admin.select().from(forms);
const storedForums = () => t.database.admin.select().from(forums);
const channelCreates = () => fb.requests.filter((request) => request.method === 'POST' && request.path === `/guilds/${GUILD}/channels`);

async function storeForum() {
  await formsDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
}

/** A post by a member; the gateway event is emitted for it. */
async function userPost(title = 'Story contest') {
  const threadId = id();
  discord.addChannel(threadId, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM, ownerId: USER, name: title });
  discord.addMessage(threadId, threadId, { content: 'hello', authorId: USER });
  const thread = await fb.client.channels.fetch(threadId);
  fb.client.emit(Events.ThreadCreate, thread, true);
  await fb.bot.idle();
  return threadId;
}

/** Every text and button label of a V2 message, flattened. */
function texts(components: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    const entry = node as { content?: string; label?: string; components?: unknown };
    if (entry.content !== undefined) out.push(entry.content);
    if (entry.label !== undefined) out.push(entry.label);
    walk(entry.components);
  };
  walk(components);
  return out;
}

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await fb.bot.stop();
  await t.drop();
});

describe('/forms init', () => {
  it('creates a hidden forum', async () => {
    await start();
    const replies = await command('init');
    const [create] = channelCreates();
    expect(create!.body).toMatchObject({
      name: 'forms',
      type: ChannelType.GuildForum,
      permission_overwrites: [
        { id: GUILD, type: OverwriteType.Role, deny: String(PermissionFlagsBits.ViewChannel) },
        { id: discord.botId, type: OverwriteType.Member, allow: String(PermissionFlagsBits.ViewChannel) },
      ],
    });
    const [stored] = await storedForums();
    expect(stored!.draftsThreadId).toBeNull();
    expect(replies).toEqual([`Forms now live in <#${stored!.forumChannelId}>.`]);
  });

  it('refuses a second time with the forum link', async () => {
    await start();
    await command('init');
    const [stored] = await storedForums();
    expect(await command('init')).toEqual([`Forms already live in <#${stored!.forumChannelId}>.`]);
    expect(channelCreates()).toHaveLength(1);
  });
});

describe('/forms list', () => {
  it('lists forms with state and links', async () => {
    await start();
    await storeForum();
    const threadId = await userPost('Story contest');
    const [row] = await storedForms();
    expect(row!.threadId).not.toBe(threadId);
    const [reply] = await command('list');
    expect(reply).toBe(`[Story contest](https://discord.com/channels/${GUILD}/${row!.threadId}) · inactive`);
  });

  it('says so when there are no forms', async () => {
    await start();
    expect(await command('list')).toEqual(['No forms yet. Run /forms init to create the forms forum.']);
  });
});

describe('forum posts', () => {
  beforeEach(async () => {
    await start();
    await storeForum();
    await fb.client.channels.fetch(FORUM);
  });

  it('turns a member post into a form with a bot post and preview', async () => {
    const threadId = await userPost('Story contest');
    const [row] = await storedForms();
    expect(row).toMatchObject({ name: 'Story contest', active: false, fields: [], oncePerMember: true });
    expect(discord.channels.has(threadId)).toBe(false);
    expect(discord.channels.get(row!.threadId)).toMatchObject({ parent_id: FORUM, owner_id: discord.botId });
    expect(row!.previewMessageId).toBe(row!.threadId);

    const preview = discord.messages.get(row!.previewMessageId)!;
    expect((preview.flags ?? 0) & MessageFlags.IsComponentsV2).toBeTruthy();
    const all = texts(preview.components);
    expect(all.join('\n')).toContain('Story contest');
    expect(all).toEqual(expect.arrayContaining(['Add field', 'Edit field', 'Settings', 'Try it', 'Export', 'Import', 'Delete']));
    const buttons: { label?: string; disabled?: boolean; custom_id: string }[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node === null || typeof node !== 'object') return;
      const entry = node as { type?: number; components?: unknown };
      if (entry.type === ComponentType.Button) buttons.push(entry as never);
      collect(entry.components);
    };
    collect(preview.components);
    expect(buttons.find((b) => b.label === 'Edit field')!.disabled).toBe(true);
    expect(buttons.find((b) => b.label === 'Try it')!.disabled).toBe(true);
    expect(buttons.find((b) => b.label === 'Add field')!.disabled).toBeFalsy();
  });

  it('ignores posts by the bot and other forums', async () => {
    const other = id();
    discord.addChannel(other, { guildId: GUILD, type: ChannelType.PublicThread, parentId: '100000000000000999', ownerId: USER, name: 'x' });
    discord.addMessage(other, other, { content: 'x', authorId: USER });
    fb.client.emit(Events.ThreadCreate, await fb.client.channels.fetch(other), true);
    await fb.bot.idle();
    expect(await storedForms()).toEqual([]);
  });

  it('renames the form when its post is renamed', async () => {
    await userPost('Story contest');
    const [row] = await storedForms();
    const before = (await fb.client.channels.fetch(row!.threadId)) as never as { name: string };
    const after = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { name: 'Poetry slam' });
    fb.client.emit(Events.ThreadUpdate, before as never, after as never);
    await fb.bot.idle();
    expect((await storedForms())[0]!.name).toBe('Poetry slam');
  });

  it('cuts the name of a long post to 45 characters', async () => {
    await userPost('x'.repeat(60));
    const [row] = await storedForms();
    expect(row!.name).toBe('x'.repeat(45));
    expect(discord.channels.get(row!.threadId)).toMatchObject({ name: 'x'.repeat(45) });
  });

  it('cuts a renamed post to 45 characters and redraws the preview', async () => {
    await userPost('Story contest');
    const [row] = await storedForms();
    const before = (await fb.client.channels.fetch(row!.threadId)) as never as { name: string };
    const after = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { name: `Poetry slam ${'y'.repeat(60)}` });
    fb.client.emit(Events.ThreadUpdate, before as never, after as never);
    await fb.bot.idle();
    const name = `Poetry slam ${'y'.repeat(33)}`;
    expect((await storedForms())[0]!.name).toBe(name);
    expect(texts(discord.messages.get(row!.previewMessageId)!.components).join('\n')).toContain(`## ${name}`);
  });

  it('deletes the form when its post is deleted', async () => {
    await userPost('Story contest');
    const [row] = await storedForms();
    fb.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id: row!.threadId, guild_id: GUILD, parent_id: FORUM, type: 11 }, s: 1 }, 0);
    await fb.bot.idle();
    expect(await storedForms()).toEqual([]);
  });

  it('deletes all forms and the forum row when the forum is deleted', async () => {
    await userPost('One');
    await userPost('Two');
    expect(await storedForms()).toHaveLength(2);
    fb.client.emit(Events.ChannelDelete, (await fb.client.channels.fetch(FORUM)) as never);
    await fb.bot.idle();
    expect(await storedForms()).toEqual([]);
    expect(await storedForums()).toEqual([]);
  });
});

describe('start-up', () => {
  it('works without sticky loaded', async () => {
    await start({ sticky: false });
    expect(fb.bot.runtimes.map((runtime) => runtime.name)).not.toContain('sticky');
    expect(fb.bot.runtimes.map((runtime) => runtime.name)).toContain('forms');
  });

  it('works with sticky loaded', async () => {
    await start({ sticky: true });
    expect(fb.bot.runtimes.map((runtime) => runtime.name)).toContain('sticky');
  });

  it('drops forms whose post was deleted while the bot was away', async () => {
    fb = await prepareFormsBot(t, discord);
    await storeForum();
    await formsDb(t).run(async (tx) => {
      await tx.insert(forms).values({ name: 'Gone', threadId: '100000000000009999', previewMessageId: '1' });
    });
    await ready(fb);
    expect(await storedForms()).toEqual([]);
  });
});
