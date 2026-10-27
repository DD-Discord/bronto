import { FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { ChannelType, type EmbedBuilder } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import {
  CHANNEL,
  channelOption,
  LOG_CHANNEL,
  LOG_THREAD,
  OTHER_CHANNEL,
  prepareMediaonlyBot,
  ready,
  ruleRows,
  runCommand,
  THREAD,
  USER,
  type MediaonlyBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let mb: MediaonlyBot;

interface Payload {
  content?: string;
  embeds?: EmbedBuilder[];
}

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  mb = await prepareMediaonlyBot(t, discord);
  await ready(mb);
});

afterEach(async () => {
  await mb.bot.stop();
  await t.drop();
});

const payloads = (fake: FakeInteraction) => fake.responses.map((response) => response.payload as Payload);
const contents = (fake: FakeInteraction) => payloads(fake).map((payload) => payload.content);
const embedJson = (fake: FakeInteraction) =>
  JSON.stringify(payloads(fake).flatMap((payload) => payload.embeds ?? []).map((embed) => embed.toJSON()));
const say = (subcommand: string, options: Record<string, unknown> = {}, channelId = CHANNEL) =>
  runCommand(mb, 'mediaonly', subcommand, options, channelId);

type CommandJson = { name: string; options: { name: string; options?: { name: string; channel_types?: number[] }[] }[] };
const registered = () =>
  (mb.requests.findLast((r) => r.method === 'PUT' && r.path.endsWith('/commands'))!.body as CommandJson[]).find((c) => c.name === 'mediaonly')!;
const channelTypesOf = (subcommand: string, option: string) =>
  registered().options.find((o) => o.name === subcommand)!.options!.find((o) => o.name === option)!.channel_types!.sort((a, b) => a - b);

describe('/mediaonly set', () => {
  it('set creates with defaults', async () => {
    expect(contents(await say('set'))).toEqual(['**Media-only rule created.**']);
    expect(await ruleRows(t)).toEqual([
      expect.objectContaining({
        channelId: CHANNEL,
        enabled: true,
        ignoreBots: true,
        requireSpoiler: false,
        logChannelId: null,
        logThreadId: null,
        logWebhookId: null,
        logWebhookToken: null,
        createdBy: USER,
      }),
    ]);
  });

  it('set changes require-spoiler only', async () => {
    await say('set', { channel: channelOption(OTHER_CHANNEL), enabled: false });
    expect(contents(await say('set', { channel: channelOption(OTHER_CHANNEL), 'require-spoiler': true }))).toEqual(['**Media-only rule updated.**']);
    expect(await ruleRows(t)).toEqual([expect.objectContaining({ channelId: OTHER_CHANNEL, enabled: false, ignoreBots: true, requireSpoiler: true })]);
    const shown = embedJson(await say('show', { channel: channelOption(OTHER_CHANNEL) }));
    expect(shown).toContain('Require spoiler');
  });

  it('works in a thread', async () => {
    await say('set', {}, THREAD);
    expect((await ruleRows(t)).map((row) => row.channelId)).toEqual([THREAD]);
  });

  it('refuses forum channels', () => {
    const expected = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread];
    expected.sort((a, b) => a - b);
    for (const subcommand of ['set', 'show', 'remove']) expect(channelTypesOf(subcommand, 'channel')).toEqual(expected);
    expect(channelTypesOf('set', 'channel')).not.toContain(ChannelType.GuildForum);
    expect(channelTypesOf('set', 'channel')).not.toContain(ChannelType.GuildMedia);
    expect(channelTypesOf('set', 'log-channel')).toEqual(expected);
  });
});

describe('log channels', () => {
  it('log channel creates and reuses a webhook', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { channel: channelOption(OTHER_CHANNEL), 'log-channel': channelOption(LOG_CHANNEL) });
    const [first, second] = await ruleRows(t);
    expect(first).toMatchObject({ logChannelId: LOG_CHANNEL, logThreadId: null });
    expect(first!.logWebhookId).not.toBeNull();
    expect(second!.logWebhookId).toBe(first!.logWebhookId);
    expect(second!.logWebhookToken).toBe(first!.logWebhookToken);
    expect(discord.webhooks.size).toBe(1);
    expect(embedJson(await say('show'))).not.toContain(first!.logWebhookToken!);
  });

  it('posts to a thread log channel through its parent', async () => {
    await say('set', { 'log-channel': channelOption(LOG_THREAD, LOG_CHANNEL) });
    const [row] = await ruleRows(t);
    expect(row).toMatchObject({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
    expect(discord.webhooks.get(row!.logWebhookId!)?.channel_id).toBe(LOG_CHANNEL);
  });

  it('remove-log-channel clears the columns and deletes the unused webhook', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    const [created] = await ruleRows(t);
    await say('set', { 'remove-log-channel': true });
    expect(await ruleRows(t)).toEqual([expect.objectContaining({ logChannelId: null, logThreadId: null, logWebhookId: null, logWebhookToken: null })]);
    expect(discord.deletedWebhooks).toEqual([created!.logWebhookId]);
  });

  it('refuses log-channel together with remove-log-channel', async () => {
    await say('set');
    const fake = await say('set', { 'log-channel': channelOption(LOG_CHANNEL), 'remove-log-channel': true });
    expect(contents(fake).join()).toContain('not both');
  });
});

describe('/mediaonly remove', () => {
  it('remove deletes the rule and its unused webhook', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { channel: channelOption(OTHER_CHANNEL), 'log-channel': channelOption(LOG_CHANNEL) });
    const [first] = await ruleRows(t);
    expect(contents(await say('remove', { channel: channelOption(OTHER_CHANNEL) }))[0]).toContain('Media-only rule deleted');
    expect(discord.deletedWebhooks).toEqual([]);
    await say('remove');
    expect(await ruleRows(t)).toEqual([]);
    expect(discord.deletedWebhooks).toEqual([first!.logWebhookId]);
  });

  it('lists the rules', async () => {
    await say('set');
    await say('set', { channel: channelOption(OTHER_CHANNEL) });
    const listed = contents(await say('list')).join('\n');
    expect(listed).toContain(`<#${CHANNEL}>`);
    expect(listed).toContain(`<#${OTHER_CHANNEL}>`);
  });
});
