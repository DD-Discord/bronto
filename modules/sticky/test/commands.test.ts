import { fakeAutocomplete, fakeCommand } from '@bronto/core/testing';
import { ChannelType, Events, type EmbedBuilder } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { Reposter, type StickyContext } from '../src/repost.js';
import { StickyIndex } from '../src/sticky-index.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import {
  CHANNEL,
  createTemplate,
  GUILD,
  insertSticky,
  message,
  prepareStickyBot,
  ready,
  sleep,
  stateOf,
  stickyRows,
  THREAD,
  USER,
  type StickyBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let sb: StickyBot;

const MISSING_TEMPLATE = '00000000-0000-4000-8000-000000000000';
let template: string;

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

async function suggest(subcommand: string, query: string) {
  const fake = fakeAutocomplete({ command: 'sticky', subcommand, focused: 'template', guildId: GUILD, channelId: CHANNEL, userId: USER, options: { template: query } });
  sb.client.emit(Events.InteractionCreate, fake);
  await sb.bot.idle();
  return fake.responses[0]!.payload;
}

/** The post link and creation date of a template, as the templates module stores them. */
async function templateInfo(id: string): Promise<{ url: string; created: string }> {
  const { rows } = await t.database.adminPool.query('select thread_id, created_at from templates.templates where id = $1', [id]);
  const row = rows[0] as { thread_id: string; created_at: Date };
  return { url: `https://discord.com/channels/${GUILD}/${row.thread_id}`, created: row.created_at.toISOString().slice(0, 10) };
}

/** A sticky with a stored copy of its message, posted by an edit so that it is indexed and live. */
async function postedSticky(values: Partial<Parameters<typeof insertSticky>[2]> = {}) {
  const row = await insertSticky(t, discord, { channelId: CHANNEL, ...values });
  await say('edit', { channel: channel(row.channelId, row.parentChannelId ?? undefined), silent: row.silent }, row.channelId);
  return row;
}

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  discord.addChannel(THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: CHANNEL });
  sb = await prepareStickyBot(t, discord);
  await ready(sb);
  template = await createTemplate(sb, 'Welcome rules');
});

afterEach(async () => {
  await sb.bot.stop();
  vi.useRealTimers();
  await t.drop();
});

describe('/sticky create', () => {
  it('creates a sticky for a template', async () => {
    expect(contents(await say('create', { channel: channel(CHANNEL), template }))).toEqual(['**Sticky created.**']);
    const [row] = await stickyRows(t);
    expect(row).toMatchObject({
      channelId: CHANNEL,
      parentChannelId: null,
      templateId: template,
      content: null,
      embeds: null,
      ignoreBots: true,
      silent: true,
      debounceMs: 0,
      createdBy: USER,
    });
    expect(discord.webhooks.get(row!.webhookId)?.channel_id).toBe(CHANNEL);
  });

  it('creates thread stickies through the parent webhook, shared with the parent sticky', async () => {
    await say('create', { channel: channel(CHANNEL), template });
    await say('create', { channel: channel(THREAD, CHANNEL), template });
    const [parent, thread] = await stickyRows(t);
    expect(thread).toMatchObject({ channelId: THREAD, parentChannelId: CHANNEL, webhookId: parent!.webhookId });
  });

  it('refuses templates that do not exist, without creating anything', async () => {
    for (const unknown of [MISSING_TEMPLATE, 'not an id']) {
      expect(contents(await say('create', { channel: channel(CHANNEL), template: unknown }))).toEqual(["That template doesn't exist."]);
    }
    expect(await stickyRows(t)).toEqual([]);
    expect(discord.webhooks.size).toBe(0);
  });

  it('suggests templates by name with their creation date', async () => {
    const other = await createTemplate(sb, 'Event info');
    const [welcome, event] = [await templateInfo(template), await templateInfo(other)];
    expect(await suggest('create', '')).toEqual([
      { name: `Event info · ${event.created}`, value: other },
      { name: `Welcome rules · ${welcome.created}`, value: template },
    ]);
    expect(await suggest('edit', 'RUL')).toEqual([{ name: `Welcome rules · ${welcome.created}`, value: template }]);
  });

  it('asks for Manage Webhooks', async () => {
    discord.override('POST', `/channels/${CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    expect(contents(await say('create', { channel: channel(CHANNEL), template }))).toEqual([
      `I need the Manage Webhooks permission in <#${CHANNEL}>.`,
    ]);
    expect(await stickyRows(t)).toEqual([]);
  });

  it('refuses a second sticky in the same channel', async () => {
    await say('create', { channel: channel(CHANNEL), template });
    expect(contents(await say('create', { channel: channel(CHANNEL), template }))).toEqual([
      `Sticky for <#${CHANNEL}> already exists.`,
    ]);
  });
});

describe('/sticky show, list and edit', () => {
  it('shows the sticky of the current channel with its template, without its webhook', async () => {
    await say('create', { channel: channel(CHANNEL), template });
    const [row] = await stickyRows(t);
    const [shown] = await say('show');
    const json = shown!.embeds!.map((embed) => embed.toJSON());
    expect(json[0]!.fields).toEqual([
      { name: 'Template', value: `[Welcome rules](${(await templateInfo(template)).url})` },
      { name: 'Ignore bots', value: 'Yes', inline: true },
      { name: 'Silent', value: 'Yes', inline: true },
      { name: 'Debounce', value: 'Off', inline: true },
    ]);
    expect(JSON.stringify(json)).not.toContain(row!.webhookToken);
    expect(JSON.stringify(json)).not.toContain(row!.webhookId);
  });

  it('shows a sticky whose template is gone', async () => {
    await insertSticky(t, discord, { channelId: CHANNEL, templateId: MISSING_TEMPLATE });
    const [shown] = await say('show', { channel: channel(CHANNEL) });
    expect(shown!.embeds![0]!.toJSON().fields![0]).toEqual({ name: 'Template', value: `Missing (\`${MISSING_TEMPLATE}\`)` });
  });

  it('explains a channel without a sticky', async () => {
    expect(contents(await say('show'))).toEqual([`There is no sticky for <#${CHANNEL}>.`]);
  });

  it('lists the stickies of the server with their templates', async () => {
    expect(contents(await say('list'))).toEqual(['There are no stickies yet.']);
    await say('create', { channel: channel(CHANNEL), template });
    await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL, templateId: MISSING_TEMPLATE });
    const { url } = await templateInfo(template);
    expect(contents(await say('list'))).toEqual([
      `**2 Stickies**\n- <#${CHANNEL}> · [Welcome rules](${url})\n- <#${THREAD}> · missing template`,
    ]);
  });

  it('switches to another template', async () => {
    const other = await createTemplate(sb, 'New rules');
    await say('create', { channel: channel(CHANNEL), template });
    expect(contents(await say('edit', { channel: channel(CHANNEL), template: other }))).toEqual(['**Sticky updated.**']);
    const [row] = await stickyRows(t);
    expect(row).toMatchObject({ templateId: other, content: null, embeds: null });
  });

  it('drops the stored copy when a sticky switches to a template', async () => {
    await postedSticky();
    await say('edit', { channel: channel(CHANNEL), template });
    const [row] = await stickyRows(t);
    expect(row).toMatchObject({ templateId: template, content: null, embeds: null });
    expect(discord.sent).toHaveLength(1);
  });

  it('refuses to switch to a template that does not exist', async () => {
    await say('create', { channel: channel(CHANNEL), template });
    expect(contents(await say('edit', { channel: channel(CHANNEL), template: MISSING_TEMPLATE }))).toEqual([
      "That template doesn't exist.",
    ]);
    expect((await stickyRows(t))[0]!.templateId).toBe(template);
  });

  it('applies changed settings to the next post', async () => {
    await postedSticky();
    await say('edit', { channel: channel(CHANNEL), silent: false });
    expect(discord.sent[1]!.options.silent).toBe(false);
  });
});

describe('/sticky delete', () => {
  it('deletes the sticky, its post and its webhook', async () => {
    const row = await postedSticky();
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.liveMessages(CHANNEL)).toEqual([]);
    expect(discord.deletedWebhooks).toEqual([row.webhookId]);
    expect(await stickyRows(t)).toEqual([]);
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });

  it('keeps a webhook another sticky still uses', async () => {
    const parent = await postedSticky();
    await postedSticky({ channelId: THREAD, parentChannelId: CHANNEL, webhookId: parent.webhookId, webhookToken: parent.webhookToken });
    await say('delete', { channel: channel(THREAD, CHANNEL) }, THREAD);
    expect(discord.deletedWebhooks).toEqual([]);
    expect(discord.liveMessages(THREAD)).toEqual([]);
    expect(discord.liveMessages(CHANNEL)).toHaveLength(1);
  });

  it('still deletes the webhook when deleting the post fails, and logs a warning', async () => {
    const row = await postedSticky();
    discord.override('DELETE', `/webhooks/${row.webhookId}/${row.webhookToken}/messages/${discord.sent[0]!.id}`, () => { throw new Error('boom'); });
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.deletedWebhooks).toEqual([row.webhookId]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'Deleting the sticky post failed' }));
  });

  it("deletes the last post with the bot's own permissions when the webhook is gone", async () => {
    const row = await postedSticky();
    const [post] = discord.liveMessages(CHANNEL);
    discord.removeWebhook(row.webhookId);
    expect(contents(await say('delete', { channel: channel(CHANNEL) }))).toEqual([`**Sticky deleted:** <#${CHANNEL}>`]);
    expect(discord.liveMessages(CHANNEL)).toEqual([]);
    expect(discord.botDeleted).toContain(post!);
  });

  it('cleans up with the webhook a repost in flight just created', async () => {
    const row = await postedSticky();
    discord.removeWebhook(row.webhookId);
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
    expect(discord.liveMessages(CHANNEL)).toEqual([]);
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
    await postedSticky({ debounceMs: 1000 });
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await sb.bot.idle();
    await say('delete', { channel: channel(CHANNEL) });
    await vi.advanceTimersByTimeAsync(1100);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    expect(discord.liveMessages(CHANNEL)).toEqual([]);
  });
});
