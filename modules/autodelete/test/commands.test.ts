import { fakeCommand } from '@bronto/core/testing';
import { Events, type EmbedBuilder } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { RuleIndex } from '../src/rule-index.js';
import { FakeAutodeleteDiscord } from './fake-discord.js';
import {
  CHANNEL,
  cooldownRows,
  GUILD,
  insertCooldown,
  insertPost,
  insertRule,
  LOG_CHANNEL,
  LOG_THREAD,
  MEMBER,
  OTHER_CHANNEL,
  postRows,
  prepareAutodeleteBot,
  ready,
  ruleRows,
  USER,
  type AutodeleteBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeAutodeleteDiscord;
let index: RuleIndex;
let ab: AutodeleteBot;

/** A channel option value as discord.js resolves it. */
const channel = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

interface Payload {
  content?: string;
  embeds?: EmbedBuilder[];
}

async function say(subcommand: string, options: Record<string, unknown> = {}, channelId = CHANNEL): Promise<Payload[]> {
  const fake = fakeCommand({ command: 'autodelete', subcommand, guildId: GUILD, channelId, userId: USER, options });
  ab.client.emit(Events.InteractionCreate, fake);
  await ab.bot.idle();
  return fake.responses.map((response) => response.payload as Payload);
}

const contents = (payloads: Payload[]) => payloads.map((payload) => payload.content);
const embedJson = (payloads: Payload[]) => JSON.stringify(payloads.flatMap((payload) => payload.embeds ?? []).map((embed) => embed.toJSON()));

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeAutodeleteDiscord();
  index = new RuleIndex();
  ab = await prepareAutodeleteBot(t, discord, { index });
  await ready(ab);
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});

describe('/autodelete create and show', () => {
  it('stores a rule with defaults', async () => {
    expect(contents(await say('create', { channel: channel(CHANNEL) }))).toEqual(['**Auto-delete rule created.**']);
    const [row] = await ruleRows(t);
    expect(row).toMatchObject({
      channelId: CHANNEL,
      enabled: true,
      keepLatest: true,
      deleteOnLeave: false,
      cooldownMs: 0,
      graceMs: 0,
      notifyDm: false,
      logChannelId: null,
      logThreadId: null,
      logWebhookId: null,
      logWebhookToken: null,
      createdBy: USER,
    });
  });

  it('parses durations and shows them (14d is shown as 2w)', async () => {
    await say('create', { channel: channel(CHANNEL), cooldown: '14d', grace: '1h' });
    const [row] = await ruleRows(t);
    expect(row).toMatchObject({ cooldownMs: 1_209_600_000, graceMs: 3_600_000 });
    const json = embedJson(await say('show'));
    expect(json).toContain('2w');
    expect(json).toContain('1h');
  });

  it('round-trips 28 days', async () => {
    await say('create', { channel: channel(CHANNEL), cooldown: '28d' });
    const [row] = await ruleRows(t);
    expect(row!.cooldownMs).toBe(2_419_200_000);
    expect(embedJson(await say('show'))).toContain('4w');
  });

  it('shows Off for durations of zero', async () => {
    await say('create', { channel: channel(CHANNEL) });
    expect(embedJson(await say('show'))).toContain('Off');
  });
});

describe('log channels', () => {
  it('offers text, announcement and all thread types for log-channel', () => {
    const commands = ab.client.registered.get(GUILD) as { name: string; options: { name: string; options?: { name: string; channel_types?: number[] }[] }[] }[];
    const create = commands.find((command) => command.name === 'autodelete')!.options.find((option) => option.name === 'create')!;
    expect(create.options!.find((option) => option.name === 'log-channel')!.channel_types!.sort((a, b) => a - b)).toEqual([0, 5, 10, 11, 12]);
  });

  it('creates a webhook and reuses it for a second rule logging to the same channel', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    await say('create', { channel: channel(OTHER_CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    const [first, second] = await ruleRows(t);
    expect(first).toMatchObject({ logChannelId: LOG_CHANNEL, logThreadId: null });
    expect(first!.logWebhookId).not.toBeNull();
    expect(second!.logWebhookId).toBe(first!.logWebhookId);
    expect(second!.logWebhookToken).toBe(first!.logWebhookToken);
    expect(discord.webhooks.size).toBe(1);
    expect(discord.webhooks.get(first!.logWebhookId!)?.channelId).toBe(LOG_CHANNEL);
  });

  it('stores the thread of a thread log channel and posts through the parent', async () => {
    discord.threads.set(LOG_THREAD, LOG_CHANNEL);
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_THREAD, LOG_CHANNEL) });
    const [row] = await ruleRows(t);
    expect(row).toMatchObject({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
    expect(discord.webhooks.get(row!.logWebhookId!)?.channelId).toBe(LOG_CHANNEL);
  });

  it('clears the log columns and deletes the unused webhook on remove-log-channel', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    const [created] = await ruleRows(t);
    expect(contents(await say('edit', { channel: channel(CHANNEL), 'remove-log-channel': true }))).toEqual(['**Auto-delete rule updated.**']);
    const [row] = await ruleRows(t);
    expect(row).toMatchObject({ logChannelId: null, logThreadId: null, logWebhookId: null, logWebhookToken: null });
    expect(discord.deletedWebhooks).toEqual([created!.logWebhookId]);
  });

  it('keeps a webhook another rule still uses when its log channel is removed', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    await say('create', { channel: channel(OTHER_CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    await say('edit', { channel: channel(CHANNEL), 'remove-log-channel': true });
    expect(discord.deletedWebhooks).toEqual([]);
    expect(discord.webhooks.size).toBe(1);
  });

  it('keeps the webhook when an edit changes other fields only', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    const [before] = await ruleRows(t);
    await say('edit', { channel: channel(CHANNEL), cooldown: '1d' });
    const [after] = await ruleRows(t);
    expect(after!.logWebhookId).toBe(before!.logWebhookId);
    expect(discord.deletedWebhooks).toEqual([]);
  });

  it('refuses log-channel together with remove-log-channel', async () => {
    await say('create', { channel: channel(CHANNEL) });
    const replies = await say('edit', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL), 'remove-log-channel': true });
    expect(contents(replies)[0]).toContain('not both');
    expect(discord.webhooks.size).toBe(0);
  });

  it('turns a missing Manage Webhooks permission into a message naming the channel', async () => {
    discord.missingWebhookPermission = true;
    expect(contents(await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) }))).toEqual([
      `I need the Manage Webhooks permission in <#${LOG_CHANNEL}>.`,
    ]);
    expect(await ruleRows(t)).toEqual([]);
  });

  it('never shows the token', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    const [row] = await ruleRows(t);
    const json = embedJson(await say('show'));
    expect(json).toContain(`<#${LOG_CHANNEL}>`);
    expect(json).not.toContain(row!.logWebhookToken!);
    expect(json).not.toContain(row!.logWebhookId!);
  });
});

describe('/autodelete delete', () => {
  it('removes an unshared log webhook and keeps a shared one', async () => {
    await say('create', { channel: channel(CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    await say('create', { channel: channel(OTHER_CHANNEL), 'log-channel': channel(LOG_CHANNEL) });
    const [first] = await ruleRows(t);
    await say('delete', { channel: channel(CHANNEL) });
    expect(discord.deletedWebhooks).toEqual([]);
    await say('delete', { channel: channel(OTHER_CHANNEL) });
    expect(discord.deletedWebhooks).toEqual([first!.logWebhookId]);
    expect(await ruleRows(t)).toEqual([]);
  });
});

describe('the rule index', () => {
  it('follows edits and deletes', async () => {
    await say('create', { channel: channel(CHANNEL) });
    expect(index.get(GUILD, CHANNEL)?.enabled).toBe(true);
    await say('edit', { channel: channel(CHANNEL), enabled: false });
    expect(index.get(GUILD, CHANNEL)?.enabled).toBe(false);
    await say('delete', { channel: channel(CHANNEL) });
    expect(index.get(GUILD, CHANNEL)).toBeUndefined();
  });

  it('is loaded from the database when the server becomes ready', async () => {
    await ab.bot.stop();
    await insertRule(t, { channelId: OTHER_CHANNEL, cooldownMs: 5 });
    const fresh = new RuleIndex();
    ab = await prepareAutodeleteBot(t, discord, { index: fresh });
    await ready(ab);
    expect(fresh.get(GUILD, OTHER_CHANNEL)?.cooldownMs).toBe(5);
  });
});

describe('/autodelete reset', () => {
  beforeEach(async () => {
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: OTHER_CHANNEL });
    await insertCooldown(t, { channelId: CHANNEL, userId: MEMBER });
    await insertCooldown(t, { channelId: OTHER_CHANNEL, userId: MEMBER });
    await insertCooldown(t, { channelId: CHANNEL, userId: USER });
    await insertPost(t, { channelId: CHANNEL, userId: MEMBER, messageId: '100000000000000600' });
  });

  const user = { id: MEMBER };
  const keys = async () => (await cooldownRows(t)).map((row) => `${row.channelId}/${row.userId}`);

  it('deletes one cooldown with a channel', async () => {
    expect(contents(await say('reset', { user, channel: channel(CHANNEL) }))).toEqual([`Cooldown reset for <@${MEMBER}> in <#${CHANNEL}>.`]);
    expect(await keys()).toEqual([`${CHANNEL}/${USER}`, `${OTHER_CHANNEL}/${MEMBER}`]);
  });

  it("deletes all of the member's cooldowns without a channel and leaves posts", async () => {
    expect(contents(await say('reset', { user }))).toEqual([`Cooldown reset for <@${MEMBER}> in 2 channels.`]);
    expect(await keys()).toEqual([`${CHANNEL}/${USER}`]);
    expect(await postRows(t)).toHaveLength(1);
  });

  it('says so when there is nothing to reset', async () => {
    await say('reset', { user });
    expect(contents(await say('reset', { user }))).toEqual([`<@${MEMBER}> has no cooldown here.`]);
    expect(contents(await say('reset', { user: { id: '100000000000000097' }, channel: channel(CHANNEL) }))).toEqual([
      '<@100000000000000097> has no cooldown here.',
    ]);
  });
});
