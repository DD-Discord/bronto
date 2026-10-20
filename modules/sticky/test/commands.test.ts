import { fakeCommand } from '@bronto/core/testing';
import { ChannelType, Events, type EmbedBuilder } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { Reposter, type StickyContext } from '../src/repost.js';
import { StickyIndex } from '../src/sticky-index.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import {
  CHANNEL,
  GUILD,
  message,
  OTHER_GUILD,
  prepareStickyBot,
  ready,
  sleep,
  stateOf,
  stickyRows,
  TEMPLATE_CHANNEL,
  TEMPLATE_MESSAGE,
  THREAD,
  USER,
  type StickyBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let sb: StickyBot;

const link = (guild = GUILD, channel = TEMPLATE_CHANNEL, messageId = TEMPLATE_MESSAGE) =>
  `https://discord.com/channels/${guild}/${channel}/${messageId}`;

/** A channel option value as discord.js resolves it. */
const channel = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

interface Payload {
  content?: string;
  embeds?: EmbedBuilder[];
}

async function say(subcommand: string, options: Record<string, unknown> = {}, channelId = CHANNEL): Promise<Payload[]> {
  const fake = fakeCommand({ command: 'sticky', subcommand, guildId: GUILD, channelId, userId: USER, options });
  sb.client.emit(Events.InteractionCreate, fake);
  await sb.bot.idle();
  return fake.responses.map((response) => response.payload as Payload);
}

const contents = (payloads: Payload[]) => payloads.map((payload) => payload.content);

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  discord.addTemplate(GUILD, TEMPLATE_CHANNEL, TEMPLATE_MESSAGE, { content: 'Read the rules.', embeds: [{ title: 'Rules' }] });
  discord.addChannel(THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: CHANNEL });
  sb = await prepareStickyBot(t, discord);
  await ready(sb);
});

afterEach(async () => {
  await sb.bot.stop();
  vi.useRealTimers();
  await t.drop();
});

describe('/sticky create', () => {
  it('creates a sticky from a message link and posts it right away', async () => {
    expect(contents(await say('create', { channel: channel(CHANNEL), template: link() }))).toEqual(['**Sticky created.**']);
    const [row] = await stickyRows(t);
    expect(row).toMatchObject({
      channelId: CHANNEL,
      parentChannelId: null,
      templateChannelId: TEMPLATE_CHANNEL,
      templateMessageId: TEMPLATE_MESSAGE,
      content: 'Read the rules.',
      embeds: [{ title: 'Rules' }],
      ignoreBots: true,
      silent: true,
      debounceMs: 0,
      createdBy: USER,
    });
    expect(discord.webhooks.get(row!.webhookId)?.channel_id).toBe(CHANNEL);
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[0]!.id]);
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(discord.sent[0]!.id);
  });

  it('creates thread stickies through the parent webhook, shared with the parent sticky', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    await say('create', { channel: channel(THREAD, CHANNEL), template: link() });
    const [parent, thread] = await stickyRows(t);
    expect(thread).toMatchObject({ channelId: THREAD, parentChannelId: CHANNEL, webhookId: parent!.webhookId });
    expect(discord.sent[1]).toMatchObject({ channelId: CHANNEL, threadId: THREAD });
  });

  it('explains templates it cannot use, without creating anything', async () => {
    discord.addTemplate(GUILD, TEMPLATE_CHANNEL, '100000000000000023', { content: '', embeds: [] });
    discord.addTemplate(GUILD, TEMPLATE_CHANNEL, '100000000000000025', { content: 'x'.repeat(2001), embeds: [] });
    const cases: Array<[string, string]> = [
      ['not a link', 'The template must be a message link (right-click a message → Copy Message Link).'],
      [link(OTHER_GUILD), 'The template must be a message in this server.'],
      [link(GUILD, TEMPLATE_CHANNEL, '100000000000000022'), "I can't read that message: it does not exist."],
      [link(GUILD, TEMPLATE_CHANNEL, '100000000000000023'), 'That message has no text or embeds to repeat.'],
      [link(GUILD, TEMPLATE_CHANNEL, '100000000000000025'), 'That message is longer than 2000 characters, which a webhook cannot post.'],
    ];
    for (const [template, expected] of cases) {
      expect(contents(await say('create', { channel: channel(CHANNEL), template }))).toEqual([expected]);
    }
    expect(await stickyRows(t)).toEqual([]);
    expect(discord.webhooks.size).toBe(0);
  });

  it('accepts a template of exactly 2000 characters', async () => {
    discord.addTemplate(GUILD, TEMPLATE_CHANNEL, '100000000000000026', { content: 'x'.repeat(2000), embeds: [] });
    expect(contents(await say('create', { channel: channel(CHANNEL), template: link(GUILD, TEMPLATE_CHANNEL, '100000000000000026') }))).toEqual([
      '**Sticky created.**',
    ]);
  });

  it('asks for Manage Webhooks', async () => {
    discord.override('POST', `/channels/${CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    expect(contents(await say('create', { channel: channel(CHANNEL), template: link() }))).toEqual([
      `I need the Manage Webhooks permission in <#${CHANNEL}>.`,
    ]);
    expect(await stickyRows(t)).toEqual([]);
  });

  it('refuses a second sticky in the same channel', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    expect(contents(await say('create', { channel: channel(CHANNEL), template: link() }))).toEqual([
      `Sticky for <#${CHANNEL}> already exists.`,
    ]);
  });
});

describe('/sticky show, list and edit', () => {
  it('shows the sticky of the current channel without its webhook', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    const [row] = await stickyRows(t);
    const [shown] = await say('show');
    const json = JSON.stringify(shown!.embeds!.map((embed) => embed.toJSON()));
    expect(json).toContain('Read the rules.');
    expect(json).not.toContain(row!.webhookToken);
    expect(json).not.toContain(row!.webhookId);
  });

  it('lists the stickies of the server', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    await say('create', { channel: channel(THREAD, CHANNEL), template: link() });
    expect(contents(await say('list'))).toEqual([`**2 Stickies**\n- <#${CHANNEL}>\n- <#${THREAD}>`]);
  });

  it('switches to a new template and reposts it', async () => {
    discord.addTemplate(GUILD, TEMPLATE_CHANNEL, '100000000000000024', { content: 'New rules.', embeds: [] });
    await say('create', { channel: channel(CHANNEL), template: link() });
    expect(contents(await say('edit', { channel: channel(CHANNEL), template: link(GUILD, TEMPLATE_CHANNEL, '100000000000000024') }))).toEqual([
      '**Sticky updated.**',
    ]);
    const [row] = await stickyRows(t);
    expect(row).toMatchObject({ content: 'New rules.', embeds: [], templateMessageId: '100000000000000024' });
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[1]!.id]);
    expect(discord.sent[1]!.message.content).toBe('New rules.');
  });

  it('applies changed settings to the next post', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    await say('edit', { channel: channel(CHANNEL), silent: false });
    expect(discord.sent[1]!.options.silent).toBe(false);
    expect(sb.requests.filter(r => r.method === 'POST' && r.path === `/channels/${CHANNEL}/webhooks`)).toHaveLength(1);
  });
});

describe('/sticky delete', () => {
  it('deletes the sticky, its post and its webhook', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    const [row] = await stickyRows(t);
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.liveMessages()).toEqual([]);
    expect(discord.deletedWebhooks).toEqual([row!.webhookId]);
    expect(await stickyRows(t)).toEqual([]);
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });

  it('keeps a webhook another sticky still uses', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    await say('create', { channel: channel(THREAD, CHANNEL), template: link() });
    await say('delete', { channel: channel(THREAD, CHANNEL) }, THREAD);
    expect(discord.deletedWebhooks).toEqual([]);
    expect(discord.liveMessages(THREAD)).toEqual([]);
    expect(discord.liveMessages(CHANNEL)).toHaveLength(1);
  });

  it('still deletes the webhook when deleting the post fails, and logs a warning', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    const [row] = await stickyRows(t);
    discord.override('DELETE', `/webhooks/${row!.webhookId}/${row!.webhookToken}/messages/${discord.sent[0]!.id}`, () => { throw new Error('boom'); });
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.deletedWebhooks).toEqual([row!.webhookId]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'Deleting the sticky post failed' }));
  });

  it("deletes the last post with the bot's own permissions when the webhook is gone", async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    const [row] = await stickyRows(t);
    const [post] = discord.liveMessages();
    discord.removeWebhook(row!.webhookId);
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.liveMessages()).toEqual([]);
    expect(discord.botDeleted).toContain(post!);
  });

  it('cleans up with the webhook a repost in flight just created', async () => {
    await say('create', { channel: channel(CHANNEL), template: link() });
    const [row] = await stickyRows(t);
    discord.removeWebhook(row!.webhookId);
    // Holds the repost inside its webhook recovery while the delete command loads the old row.
    let release!: () => void;
    let reached!: () => void;
    const inRecovery = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const recoveryPath = `/channels/${CHANNEL}/webhooks`;
    discord.override('POST', recoveryPath, async request => {
      reached(); await gate; discord.clearOverride('POST', recoveryPath); return discord.answer(request);
    });
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await inRecovery;
    const fake = fakeCommand({ command: 'sticky', subcommand: 'delete', guildId: GUILD, channelId: CHANNEL, userId: USER, options: { channel: channel(CHANNEL) } });
    sb.client.emit(Events.InteractionCreate, fake);
    await sleep(100);
    release();
    await sb.bot.idle();
    // Only the first post went through the repost's fallback; the replacement post was removed by the cleanup itself.
    expect(discord.botDeleted).toHaveLength(1);
    expect(discord.liveMessages()).toEqual([]);
    expect([...discord.webhooks.keys()]).toEqual([]);
    expect(await stickyRows(t)).toEqual([]);
  });

  it('queues no repost for a channel without a sticky', async () => {
    const reposter = new Reposter({ index: new StickyIndex() });
    const runs: string[] = [];
    const ctx = { queue: { run: async (key: string) => void runs.push(key) } } as unknown as StickyContext;
    await reposter.queueRepost(ctx, CHANNEL);
    expect(runs).toEqual([]);
  });

  it('posts nothing after a delete, even with a debounce pending', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await say('create', { channel: channel(CHANNEL), template: link(), debounce: '1s' });
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await sb.bot.idle();
    await say('delete', { channel: channel(CHANNEL) });
    await vi.advanceTimersByTimeAsync(1100);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    expect(discord.liveMessages()).toEqual([]);
  });
});
