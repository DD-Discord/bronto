import { FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { CHANNEL, channelOption, CUSTOM, FOREIGN, IGNORED, MEMBER, OTHER_CHANNEL, prepareAutoreactBot, ready, ruleRows, runCommand, THREAD, USER, type AutoreactBot } from './harness.js';

const THUMBS = '\u{1F44D}';
const PARTY = '\u{1F389}';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let ab: AutoreactBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  ab = await prepareAutoreactBot(t, discord);
  await ready(ab);
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});

interface Payload {
  content?: string;
  embeds?: { toJSON(): unknown }[];
}
const payloads = (fake: FakeInteraction) => fake.responses.map((response) => response.payload as Payload);
const contents = (fake: FakeInteraction) => payloads(fake).map((payload) => payload.content);
const embedJson = (fake: FakeInteraction) => JSON.stringify(payloads(fake).flatMap((payload) => payload.embeds ?? []).map((embed) => embed.toJSON()));
const say = (subcommand: string, options: Record<string, unknown> = {}, channelId = CHANNEL) => runCommand(ab, 'autoreact', subcommand, options, channelId);
const user = (id: string) => ({ id });

type CommandJson = { name: string; options: { name: string; options?: { name: string; channel_types?: number[] }[] }[] };
const channelTypesOf = (subcommand: string) => {
  const registered = (ab.requests.findLast((r) => r.method === 'PUT' && r.path.endsWith('/commands'))!.body as CommandJson[]).find((c) => c.name === 'autoreact')!;
  return registered.options.find((o) => o.name === subcommand)!.options!.find((o) => o.name === 'channel')!.channel_types!.sort((a, b) => a - b);
};

describe('/autoreact set', () => {
  it('creates with defaults', async () => {
    expect(contents(await say('set', { emojis: `${THUMBS} ${PARTY}` }))).toEqual(['**Autoreact rule created.**']);
    expect(await ruleRows(t)).toEqual([
      expect.objectContaining({ channelId: CHANNEL, enabled: true, ignoreBots: true, emojis: [THUMBS, PARTY], ignoredUserIds: [], createdBy: USER }),
    ]);
  });

  it('set requires emojis on create', async () => {
    expect(contents(await say('set'))[0]).toContain('`emojis` is needed');
    expect(await ruleRows(t)).toEqual([]);
  });

  it('changes only the options given', async () => {
    await say('set', { emojis: THUMBS });
    expect(contents(await say('set', { 'ignore-bots': false }))).toEqual(['**Autoreact rule updated.**']);
    expect(await ruleRows(t)).toEqual([expect.objectContaining({ ignoreBots: false, emojis: [THUMBS] })]);
    await say('set', { emojis: `${PARTY}, ${CUSTOM}` });
    expect((await ruleRows(t))[0]).toMatchObject({ ignoreBots: false, emojis: [PARTY, CUSTOM] });
  });

  it('refuses invalid emojis and keeps the rule', async () => {
    await say('set', { emojis: THUMBS });
    expect(contents(await say('set', { emojis: `${THUMBS} ${FOREIGN}` }))[0]).toContain(FOREIGN);
    expect(contents(await say('set', { emojis: 'hello' }))[0]).toContain('hello');
    expect((await ruleRows(t))[0]!.emojis).toEqual([THUMBS]);
  });

  it('works in a thread and for another channel', async () => {
    await say('set', { emojis: THUMBS }, THREAD);
    await say('set', { channel: channelOption(OTHER_CHANNEL), emojis: THUMBS });
    expect((await ruleRows(t)).map((row) => row.channelId).sort()).toEqual([OTHER_CHANNEL, THREAD].sort());
  });

  it('ignore-user and unignore-user', async () => {
    await say('set', { emojis: THUMBS, 'ignore-user': user(IGNORED) });
    expect((await ruleRows(t))[0]!.ignoredUserIds).toEqual([IGNORED]);
    await say('set', { 'ignore-user': user(MEMBER) });
    await say('set', { 'ignore-user': user(MEMBER) });
    expect((await ruleRows(t))[0]!.ignoredUserIds).toEqual([IGNORED, MEMBER]);
    expect(contents(await say('set', { 'unignore-user': user(IGNORED) }))).toEqual(['**Autoreact rule updated.**']);
    expect((await ruleRows(t))[0]!.ignoredUserIds).toEqual([MEMBER]);
    await say('set', { 'unignore-user': user(USER) });
    expect((await ruleRows(t))[0]!.ignoredUserIds).toEqual([MEMBER]);
  });

  it('refuses ignoring and unignoring one user at once', async () => {
    await say('set', { emojis: THUMBS });
    expect(contents(await say('set', { 'ignore-user': user(MEMBER), 'unignore-user': user(MEMBER) }))[0]).toContain('not both');
  });

  it('refuses forum channels', () => {
    const expected = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread];
    expected.sort((a, b) => a - b);
    for (const subcommand of ['set', 'show', 'remove']) expect(channelTypesOf(subcommand)).toEqual(expected);
    expect(channelTypesOf('set')).not.toContain(ChannelType.GuildForum);
    expect(channelTypesOf('set')).not.toContain(ChannelType.GuildMedia);
  });
});

describe('show, list and remove', () => {
  it('shows emojis and ignored users as mentions', async () => {
    await say('set', { emojis: `${THUMBS} ${CUSTOM}`, 'ignore-user': user(IGNORED) });
    const shown = embedJson(await say('show'));
    expect(shown).toContain(THUMBS);
    expect(shown).toContain(CUSTOM);
    expect(shown).toContain(`<@${IGNORED}>`);
  });

  it('lists the rules', async () => {
    await say('set', { emojis: THUMBS });
    await say('set', { channel: channelOption(OTHER_CHANNEL), emojis: THUMBS });
    const listed = contents(await say('list')).join('\n');
    expect(listed).toContain(`<#${CHANNEL}>`);
    expect(listed).toContain(`<#${OTHER_CHANNEL}>`);
  });

  it('removes the rule', async () => {
    await say('set', { emojis: THUMBS });
    expect(contents(await say('remove'))[0]).toContain('Autoreact rule deleted');
    expect(await ruleRows(t)).toEqual([]);
  });
});
