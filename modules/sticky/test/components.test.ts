import { answer, defineModule, on, type HandlerContext } from '@bronto/core';
import { fakeCommand, FakeDiscordHttp } from '@bronto/core/testing';
import { templatesEvents } from '@bronto/templates';
import { ComponentType, Events, type APIActionRowComponent, type APIComponentInMessageActionRow } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import sticky, { stickyAsks, stickyEvents, type StickyApi } from '../src/index.js';
import { CHANNEL, createTemplate, GUILD, insertSticky, message, prepareStickyBot, QUIET_CHANNEL, ready, USER, type StickyBot } from './harness.js';

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
