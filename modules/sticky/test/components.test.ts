import { answer, defineModule, on, type HandlerContext } from '@bronto/core';
import { fakeCommand, FakeDiscordHttp } from '@bronto/core/testing';
import { templatesEvents } from '@bronto/templates';
import { ChannelType, ComponentType, Events, type APIActionRowComponent, type APIComponentInMessageActionRow } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import sticky, { stickyAsks, stickyEvents, type StickyApi } from '../src/index.js';
import { CHANNEL, createTemplate, GUILD, insertSticky, message, prepareStickyBot, QUIET_CHANNEL, ready, stickyRows, THREAD, USER, type StickyBot } from './harness.js';

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;

const row = (id: string): Row => ({
  type: ComponentType.ActionRow,
  components: [{ type: ComponentType.Button, style: 1, custom_id: id, label: id }],
});

let t: TestDatabase;
let discord: FakeDiscordHttp;
let sb: StickyBot;
/** What the test module's listener answers with. */
let answerWith: () => Row[];

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  answerWith = () => [row('one')];
});

afterEach(async () => {
  await sb.bot.stop();
  await t.drop();
});

/** Starts the bot; `seed` runs before the guild is ready so stickies it stores are indexed. */
async function start(extraListeners: ReturnType<typeof on>[] = [], seed?: () => Promise<void>): Promise<void> {
  const buttons = defineModule({
    name: 'sticky_buttons',
    dependsOn: [sticky],
    listeners: [answer(stickyAsks.components, () => answerWith()), ...extraListeners],
  });
  sb = await prepareStickyBot(t, discord, { extra: [{ packageName: '@test/buttons', definition: buttons, config: {} }] });
  await seed?.();
  await ready(sb);
}

async function say(channelId: string): Promise<void> {
  sb.client.emit(Events.MessageCreate, message(channelId));
  await sb.bot.idle();
}

/** Runs a /sticky subcommand on a channel. */
async function command(subcommand: string, channelId: string, options: Record<string, unknown>): Promise<void> {
  const channel = { id: channelId, isThread: () => false, parentId: null };
  sb.client.emit(
    Events.InteractionCreate,
    fakeCommand({ command: 'sticky', subcommand, guildId: GUILD, channelId, userId: USER, options: { channel, ...options } }),
  );
  await sb.bot.idle();
}

const webhookRequests = (method: string) =>
  sb.requests.filter((request) => request.method === method && request.path.startsWith('/webhooks/'));

describe('components collector', () => {
  it('appends contributed rows to each post', async () => {
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    const [post] = webhookRequests('POST');
    expect(post).toMatchObject({ body: { components: [row('one')] } });
    expect(post!.query).toContain('with_components=true');
  });

  it('posts without the rows of a failing listener', async () => {
    answerWith = () => {
      throw new Error('boom');
    };
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    expect(webhookRequests('POST')).toHaveLength(1);
    expect(webhookRequests('POST')[0]).toMatchObject({ body: { components: [] } });
  });

  it('caps rows at five', async () => {
    answerWith = () => ['a', 'b', 'c', 'd', 'e', 'f'].map(row);
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    const body = webhookRequests('POST')[0]!.body as { components: Row[] };
    expect(body.components).toEqual(['a', 'b', 'c', 'd', 'e'].map(row));
    const warnings = sb.lines.filter((line) => line.msg === 'Dropped sticky component rows over the limit of 5');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ channelId: CHANNEL, dropped: 1 });
  });

  it('keeps rows when the template changes', async () => {
    await start();
    const template = await createTemplate(sb, 'Rules');
    await command('create', CHANNEL, { template });
    await t.database.adminPool.query('update templates.templates set content = $2 where id = $1', [template, 'New rules']);
    const runtime = sb.bot.runtimes.find((entry) => entry.name === 'templates')!;
    await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => ctx.emit(templatesEvents.updated, { id: template }));
    await sb.bot.idle();
    const patches = webhookRequests('PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ body: { content: 'New rules', components: [row('one')] } });
    expect(patches[0]!.query).toContain('with_components=true');
  });
});

describe('rows Discord rejects', () => {
  const noId: Row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'x' } as never] };

  it('skips an answer with more than five buttons per row', async () => {
    answerWith = () => [{ type: ComponentType.ActionRow, components: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => row(id).components[0]!) }];
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    expect(webhookRequests('POST')).toHaveLength(1);
    expect(webhookRequests('POST')[0]).toMatchObject({ body: { components: [] } });
  });

  it('skips an answer holding a select', async () => {
    answerWith = () => [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: 's', options: [] } as never] }];
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    expect(webhookRequests('POST')[0]).toMatchObject({ body: { components: [] } });
  });

  it('posts again without rows when Discord rejects them', async () => {
    answerWith = () => [noId];
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    const posts = webhookRequests('POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ body: { components: [noId] } });
    expect(posts[1]).toMatchObject({ body: { components: [] } });
    expect(discord.sent).toHaveLength(1);
    const warning = sb.lines.find((line) => line.msg === 'Sticky rows were rejected; posted without them');
    expect(warning).toMatchObject({ level: 40, channelId: CHANNEL });
  });

  it('leaves one live post after a rejected repost', async () => {
    answerWith = () => [];
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    answerWith = () => [noId];
    await say(CHANNEL);
    expect([...discord.messages.values()].filter((m) => m.webhook_id !== undefined)).toHaveLength(1);
  });

  it('edits without rows when Discord rejects them', async () => {
    answerWith = () => [];
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    answerWith = () => [noId];
    const runtime = sb.bot.runtimes.find((entry) => entry.name === 'sticky_buttons')!;
    await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => ctx.modules.get(sticky).refresh(CHANNEL));
    await sb.bot.idle();
    const patches = webhookRequests('PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ body: { components: [] } });
    expect(sb.lines.some((line) => line.msg === 'Sticky rows were rejected; posted without them')).toBe(true);
  });
});

describe('foreign webhooks', () => {
  const FOREIGN_APP = '100000000000000092';

  async function seedForeign(): Promise<{ id: string; token: string }> {
    const webhook = discord.addWebhook(CHANNEL, undefined, { applicationId: FOREIGN_APP });
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL, webhookId: webhook.id, webhookToken: webhook.token })));
    return webhook;
  }

  it('replaces a foreign webhook when rows are shown', async () => {
    const old = await seedForeign();
    await say(CHANNEL);
    const posts = webhookRequests('POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).not.toContain(old.id);
    expect(posts[0]).toMatchObject({ body: { components: [row('one')] } });
    const { rows } = await t.database.adminPool.query('select webhook_id from sticky.stickies where channel_id = $1', [CHANNEL]);
    expect(rows[0].webhook_id).not.toBe(old.id);
    expect(discord.webhooks.has(old.id)).toBe(false);
  });

  it('removes the previous post through the channel when replacing', async () => {
    const old = await seedForeign();
    answerWith = () => [];
    await say(CHANNEL);
    const previous = discord.sent[0]!.id;
    answerWith = () => [row('one')];
    await say(CHANNEL);
    expect(sb.requests.some((r) => r.method === 'DELETE' && r.path === `/channels/${CHANNEL}/messages/${previous}`)).toBe(true);
    expect(discord.messages.has(previous)).toBe(false);
    expect(webhookRequests('POST').at(-1)!.path).not.toContain(old.id);
    expect(webhookRequests('POST').at(-1)).toMatchObject({ body: { components: [row('one')] } });
  });

  it('replaces a webhook created by hand when rows are shown', async () => {
    const old = discord.addWebhook(CHANNEL, undefined, { applicationId: null });
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL, webhookId: old.id, webhookToken: old.token })));
    await say(CHANNEL);
    const posts = webhookRequests('POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).not.toContain(old.id);
    expect(discord.webhooks.has(old.id)).toBe(false);
  });

  it('keeps a foreign webhook without rows', async () => {
    answerWith = () => [];
    const old = await seedForeign();
    await say(CHANNEL);
    expect(webhookRequests('POST')).toHaveLength(1);
    expect(webhookRequests('POST')[0]!.path).toContain(old.id);
    expect(discord.webhooks.has(old.id)).toBe(true);
  });

  it('keeps a foreign webhook another sticky shares', async () => {
    const old = discord.addWebhook(CHANNEL, undefined, { applicationId: FOREIGN_APP });
    await start([], async () => {
      await insertSticky(t, discord, { channelId: CHANNEL, webhookId: old.id, webhookToken: old.token });
      await insertSticky(t, discord, { channelId: QUIET_CHANNEL, webhookId: old.id, webhookToken: old.token });
    });
    await say(CHANNEL);
    expect(discord.webhooks.has(old.id)).toBe(true);
  });

  it('refresh falls back to a repost on a foreign webhook', async () => {
    answerWith = () => [];
    const old = await seedForeign();
    await say(CHANNEL);
    answerWith = () => [row('two')];
    const runtime = sb.bot.runtimes.find((entry) => entry.name === 'sticky_buttons')!;
    await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => ctx.modules.get(sticky).refresh(CHANNEL));
    await sb.bot.idle();
    expect(webhookRequests('PATCH')).toHaveLength(0);
    expect(webhookRequests('POST')).toHaveLength(2);
    expect(webhookRequests('POST')[1]!.path).not.toContain(old.id);
    expect(webhookRequests('POST')[1]).toMatchObject({ body: { components: [row('two')] } });
  });
});

describe('api', () => {
  async function asOther<T>(run: (ctx: HandlerContext, api: StickyApi) => Promise<T>): Promise<T> {
    const runtime = sb.bot.runtimes.find((entry) => entry.name === 'sticky_buttons')!;
    let result: T | undefined;
    const outcome = await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
      result = await run(ctx, ctx.modules.get(sticky));
    });
    if (!outcome.ok) throw outcome.error;
    await sb.bot.idle();
    return result as T;
  }

  it('refresh re-renders in place', async () => {
    await start([], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    await say(CHANNEL);
    answerWith = () => [row('two')];
    await asOther((_ctx, api) => api.refresh(CHANNEL));
    expect(webhookRequests('POST')).toHaveLength(1);
    const patches = webhookRequests('PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ body: { components: [row('two')] } });
    expect(discord.messages.get(discord.sent[0]!.id)?.components).toEqual([row('two')]);
  });

  it('refresh without a sticky does nothing', async () => {
    await start();
    const before = sb.requests.length;
    await asOther((_ctx, api) => api.refresh(QUIET_CHANNEL));
    expect(sb.requests.length).toBe(before);
  });

  it('exists tells whether the channel has a sticky', async () => {
    await start();
    await command('create', CHANNEL, { template: await createTemplate(sb, 'Rules') });
    expect(await asOther((_ctx, api) => api.exists(CHANNEL))).toBe(true);
    expect(await asOther((_ctx, api) => api.exists(QUIET_CHANNEL))).toBe(false);
  });
});

describe('deleted event', () => {
  it('is emitted when a sticky is deleted', async () => {
    const seen: string[] = [];
    await start([on(stickyEvents.deleted, (_ctx, { channelId }) => void seen.push(channelId))]);
    await command('create', CHANNEL, { template: await createTemplate(sb, 'Rules') });
    await command('delete', CHANNEL, {});
    expect(seen).toEqual([CHANNEL]);
  });
});

describe('deleted channels', () => {
  const seen: string[] = [];
  beforeEach(() => void (seen.length = 0));
  const listener = () => on(stickyEvents.deleted, (_ctx, { channelId }) => void seen.push(channelId));
  const rawThreadDelete = (id: string, parentId = CHANNEL) =>
    sb.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id, guild_id: GUILD, parent_id: parentId, type: 11 }, s: 1 }, 0);

  it('removes the sticky of a deleted channel', async () => {
    let webhook = '';
    await start([listener()], async () => void (webhook = (await insertSticky(t, discord, { channelId: CHANNEL })).webhookId));
    await say(CHANNEL);
    const channel = await sb.client.channels.fetch(CHANNEL);
    sb.client.emit(Events.ChannelDelete, channel as never);
    await sb.bot.idle();
    expect(await stickyRows(t)).toHaveLength(0);
    expect(seen).toEqual([CHANNEL]);
    expect(sb.requests.some((r) => r.method === 'DELETE')).toBe(false);
    // The channel's webhooks go with it; the module doesn't call Discord.
    expect(discord.webhooks.has(webhook)).toBe(true);
    const before = webhookRequests('POST').length;
    await say(CHANNEL);
    expect(webhookRequests('POST')).toHaveLength(before);
  });

  it('removes the sticky of a deleted thread and its webhook', async () => {
    const row = discord.addWebhook(CHANNEL);
    await start([listener()], async () => void (await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL, webhookId: row.id, webhookToken: row.token })));
    rawThreadDelete(THREAD);
    await sb.bot.idle();
    expect(await stickyRows(t)).toHaveLength(0);
    expect(seen).toEqual([THREAD]);
    expect(discord.webhooks.has(row.id)).toBe(false);
  });

  it('keeps a webhook another sticky shares', async () => {
    const shared = discord.addWebhook(CHANNEL);
    await start([listener()], async () => {
      await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL, webhookId: shared.id, webhookToken: shared.token });
      await insertSticky(t, discord, { channelId: CHANNEL, webhookId: shared.id, webhookToken: shared.token });
    });
    rawThreadDelete(THREAD);
    await sb.bot.idle();
    expect((await stickyRows(t)).map((s) => s.channelId)).toEqual([CHANNEL]);
    expect(discord.webhooks.has(shared.id)).toBe(true);
  });

  it('removes the stickies of threads whose parent was deleted', async () => {
    await start([listener()], async () => void (await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL })));
    const channel = await sb.client.channels.fetch(CHANNEL);
    sb.client.emit(Events.ChannelDelete, channel as never);
    await sb.bot.idle();
    expect(await stickyRows(t)).toHaveLength(0);
    expect(seen).toEqual([THREAD]);
  });

  it('ignores unrelated channels and threads', async () => {
    await start([listener()], async () => void (await insertSticky(t, discord, { channelId: CHANNEL })));
    discord.addChannel('100000000000008200', { guildId: GUILD, type: ChannelType.GuildText });
    const other = await sb.client.channels.fetch('100000000000008200');
    sb.client.emit(Events.ChannelDelete, other as never);
    rawThreadDelete('100000000000008201', '100000000000008200');
    await sb.bot.idle();
    expect(await stickyRows(t)).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});
