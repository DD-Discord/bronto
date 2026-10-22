import { fakeCommand, FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, Events, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forums } from '../src/db/schema.js';
import { FORUM, GUILD, prepareTemplatesBot, ready, templatesDb, USER, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;

async function start(options: { community?: boolean } = {}): Promise<void> {
  tb = await prepareTemplatesBot(t, discord, options);
  await ready(tb);
}

async function init(): Promise<string[]> {
  const fake = fakeCommand({ command: 'templates', subcommand: 'init', guildId: GUILD, channelId: FORUM, userId: USER, options: {} });
  tb.client.emit(Events.InteractionCreate, fake);
  await tb.bot.idle();
  return fake.responses.map((response) => (response.payload as { content?: string }).content ?? '');
}

const storedForums = () => t.database.admin.select().from(forums);
const channelCreates = () => tb.requests.filter((request) => request.method === 'POST' && request.path === `/guilds/${GUILD}/channels`);

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await tb.bot.stop();
  await t.drop();
});

describe('/templates init', () => {
  it('creates a hidden forum', async () => {
    await start();
    const replies = await init();
    const [create] = channelCreates();
    expect(create!.body).toMatchObject({
      name: 'templates',
      type: ChannelType.GuildForum,
      permission_overwrites: [
        { id: GUILD, type: OverwriteType.Role, deny: String(PermissionFlagsBits.ViewChannel) },
        { id: discord.botId, type: OverwriteType.Member, allow: String(PermissionFlagsBits.ViewChannel) },
      ],
    });
    const [stored] = await storedForums();
    expect(discord.channels.get(stored!.forumChannelId)?.type).toBe(ChannelType.GuildForum);
    expect(replies).toEqual([`Templates now live in <#${stored!.forumChannelId}>.`]);
  });

  it('refuses while the forum exists', async () => {
    await start();
    await templatesDb(t).run(async (tx) => {
      await tx.insert(forums).values({ forumChannelId: FORUM });
    });
    expect(await init()).toEqual([`Templates already live in <#${FORUM}>.`]);
    expect(channelCreates()).toEqual([]);
    expect(await storedForums()).toMatchObject([{ forumChannelId: FORUM }]);
  });

  it('replaces a stored forum that was deleted', async () => {
    await start();
    const gone = '100000000000000011';
    await templatesDb(t).run(async (tx) => {
      await tx.insert(forums).values({ forumChannelId: gone });
    });
    await init();
    const [stored] = await storedForums();
    expect(stored!.forumChannelId).not.toBe(gone);
    expect(channelCreates()).toHaveLength(1);
  });

  it('on a non-Community server explains why', async () => {
    await start({ community: false });
    expect(await init()).toEqual(['Forum channels need a Community server. Turn on Community in Server Settings first.']);
    expect(channelCreates()).toEqual([]);
    expect(await storedForums()).toEqual([]);
  });
});
