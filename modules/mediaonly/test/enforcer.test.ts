import { defineModule, on, type HandlerContext, type LoadedModule } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import templates from '@bronto/templates';
import { Collection, Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import mediaonly from '../src/index.js';
import {
  CHANNEL,
  channelOption,
  fakeMember,
  fakeMessage,
  GUILD,
  insertRule,
  LOG_CHANNEL,
  MEMBER,
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
let mb: MediaonlyBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  vi.useRealTimers();
  await mb?.bot.stop();
  mb = undefined;
  await t.drop();
});

async function start(options: { sticky?: boolean; extra?: LoadedModule[] } = {}): Promise<MediaonlyBot> {
  mb = await prepareMediaonlyBot(t, discord, options);
  return mb;
}

/** Sends messages the way the gateway does: each into the fake channel, then as an event. */
async function say(...messages: ReturnType<typeof fakeMessage>[]): Promise<void> {
  for (const message of messages) {
    discord.addPost(message.channelId, message.id, { content: message.content, attachmentCount: message.attachments.size });
    mb!.client.emit(Events.MessageCreate, message);
  }
  await mb!.bot.idle();
}

async function loggedRule(values: Parameters<typeof insertRule>[1]) {
  const webhook = discord.addWebhook(LOG_CHANNEL);
  return insertRule(t, { logChannelId: LOG_CHANNEL, logWebhookId: webhook.id, logWebhookToken: webhook.token, ...values });
}

/** The bot's own messages sent into a channel (not through a webhook). */
const notices = (channelId = CHANNEL) =>
  mb!.requests.filter((request) => request.method === 'POST' && request.path === `/channels/${channelId}/messages`);
const noticeBody = (index = 0) => notices()[index]!.body as { content: string; allowed_mentions: unknown };
const reportText = () => JSON.stringify(discord.reports.map((report) => report.message));
const dmText = () => JSON.stringify(discord.dms.map((dm) => dm.message));
const closeDms = () =>
  discord.override('POST', '/users/@me/channels', () => ({ status: 403, json: { code: 50007, message: 'Cannot send messages to this user' } }));

describe('enforcing', () => {
  it('deletes, notices, DMs and reports', async () => {
    await start();
    await loggedRule({ channelId: CHANNEL });
    await ready(mb!);
    const message = fakeMessage(CHANNEL, { content: 'Only words, no picture' });
    await say(message);

    expect(discord.deletedPosts).toEqual([message.id]);
    expect(notices()).toHaveLength(1);
    expect(noticeBody().content).toMatch(new RegExp(`^<@${MEMBER}> `));
    expect(noticeBody().content).toContain('attachment or a link');
    expect(noticeBody().allowed_mentions).toEqual({ users: [MEMBER] });

    expect(discord.dms.map((dm) => dm.userId)).toEqual([MEMBER]);
    expect(dmText()).toContain(`<#${CHANNEL}>`);
    expect(dmText()).toContain('Only words, no picture');

    expect(discord.reports).toHaveLength(1);
    expect(discord.reports[0]!.options).toEqual({ username: `User ${MEMBER.slice(-3)}`, avatarUrl: `https://cdn.example.test/members/${MEMBER}.png` });
    const webhookPost = mb!.requests.find((request) => request.method === 'POST' && request.path.startsWith('/webhooks/'))!;
    expect((webhookPost.body as { allowed_mentions: unknown }).allowed_mentions).toEqual({ parse: [] });
    expect(reportText()).toContain(`<@${MEMBER}>`);
    expect(reportText()).toContain(`<#${CHANNEL}>`);
    expect(reportText()).toContain('Only words, no picture');
    expect(reportText()).toContain('0 attachments');
    expect(reportText()).not.toContain('DMs are closed');
  });

  it('notice when DMs are closed', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(mb!);
    closeDms();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const message = fakeMessage(CHANNEL);
    await say(message);

    expect(discord.deletedPosts).toEqual([message.id]);
    expect(discord.dms).toEqual([]);
    expect(discord.reports).toEqual([]);
    expect(notices()).toHaveLength(1);
    const noticeId = [...discord.messages.values()].find((m) => m.channel_id === CHANNEL && m.content.startsWith(`<@${MEMBER}>`))!.id;

    await vi.advanceTimersByTimeAsync(9_000);
    expect(discord.deletedPosts).toEqual([message.id]);
    await vi.advanceTimersByTimeAsync(1_000);
    await mb!.bot.idle();
    expect(discord.deletedPosts).toEqual([message.id, noticeId]);
  });

  it('reports closed DMs', async () => {
    await start();
    await loggedRule({ channelId: CHANNEL });
    await ready(mb!);
    closeDms();
    await say(fakeMessage(CHANNEL));
    expect(reportText()).toContain('DMs are closed');
  });

  it('reports a DM that failed for another reason', async () => {
    await start();
    await loggedRule({ channelId: CHANNEL });
    await ready(mb!);
    discord.override('POST', '/users/@me/channels', () => ({ status: 500, json: { message: 'Internal error' } }));
    await say(fakeMessage(CHANNEL));
    expect(reportText()).toContain("Couldn't send them a DM.");
    expect(reportText()).not.toContain('DMs are closed');
  });

  it('keeps forwarded media and removes forwarded text', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(mb!);
    const forward = (content: string, spoilers: boolean[]) => ({
      ...fakeMessage(CHANNEL, { content: '' }),
      messageSnapshots: new Collection([
        ['1', { content, attachments: new Collection(spoilers.map((spoiler, i) => [String(i), { spoiler }] as const)) }],
      ]),
    });
    const picture = forward('', [false]);
    const text = forward('Only words', []);
    await say(picture, text);
    expect(discord.deletedPosts).toEqual([text.id]);
  });

  it('report notes a failed delete', async () => {
    await start();
    await loggedRule({ channelId: CHANNEL });
    await ready(mb!);
    const message = fakeMessage(CHANNEL, { content: 'Undeletable words' });
    discord.override('DELETE', `/channels/${CHANNEL}/messages/${message.id}`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    await say(message);

    expect(discord.deletedPosts).toEqual([]);
    expect(notices()).toEqual([]);
    expect(discord.dms).toEqual([]);
    expect(discord.reports).toHaveLength(1);
    expect(reportText()).toContain('Manage Messages');
    expect(reportText()).toContain('Undeletable words');
  });

  it('stops when the post is already gone', async () => {
    await start();
    await loggedRule({ channelId: CHANNEL });
    await ready(mb!);
    mb!.client.emit(Events.MessageCreate, fakeMessage(CHANNEL));
    await mb!.bot.idle();
    expect(notices()).toEqual([]);
    expect(discord.dms).toEqual([]);
    expect(discord.reports).toEqual([]);
  });

  it('names the reason for posts that are not spoilered', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, requireSpoiler: true });
    await ready(mb!);
    const message = fakeMessage(CHANNEL, { content: 'look', attachments: [false] });
    await say(message);
    expect(discord.deletedPosts).toEqual([message.id]);
    expect(noticeBody().content).toContain('spoiler');
    expect(dmText()).toContain('spoiler');
  });

  it("skips the sticky's own post", async () => {
    await start({ sticky: true });
    discord.addMember(GUILD, USER);
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(mb!);
    const runtime = mb!.bot.runtimes.find((entry) => entry.name === 'sticky')!;
    let template = '';
    const outcome = await mb!.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx: HandlerContext) => {
      template = (await ctx.modules.get(templates).create({ name: 'Rules', content: 'Read the rules.', embed: null })).id;
    });
    expect(outcome.ok).toBe(true);
    await runCommand(mb!, 'sticky', 'create', { channel: channelOption(CHANNEL), template });
    const stickyWebhook = discord.sent[0]!.webhookId;

    const stickyPost = fakeMessage(CHANNEL, { content: 'Read the rules.', member: null, bot: true, webhookId: stickyWebhook });
    const otherWebhook = fakeMessage(CHANNEL, { content: 'Other words', member: null, bot: true, webhookId: '100000000000000777' });
    await say(stickyPost, otherWebhook);
    expect(discord.deletedPosts).not.toContain(stickyPost.id);
    expect(discord.deletedPosts).toContain(otherWebhook.id);
  });

  it('leaves its own reports alone in a logged rule channel', async () => {
    await start();
    await loggedRule({ channelId: LOG_CHANNEL, ignoreBots: false });
    await ready(mb!);
    await say(fakeMessage(LOG_CHANNEL, { content: 'First words' }));
    expect(discord.reports).toHaveLength(1);
    const report = discord.sent[0]!;
    // The report comes back through the gateway as a webhook message without a member.
    await say(fakeMessage(LOG_CHANNEL, { content: '', member: null, bot: true, webhookId: report.webhookId }));
    expect(discord.deletedPosts).toHaveLength(1);
    expect(discord.reports).toHaveLength(1);
  });

  it('leaves posts of the bot itself alone', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(mb!);
    const own = fakeMessage(CHANNEL, { member: null, bot: true });
    own.author.id = discord.botId;
    await say(own);
    expect(discord.deletedPosts).toEqual([]);
  });

  it('skips human posts without member data', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(mb!);
    await say(fakeMessage(CHANNEL, { member: null }));
    expect(discord.deletedPosts).toEqual([]);
  });

  it('skips members with Manage Messages', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(mb!);
    await say(fakeMessage(CHANNEL, { member: fakeMember(MEMBER, { exempt: true }) }));
    expect(discord.deletedPosts).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('ignores other channels and threads of a rule channel', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(mb!);
    await say(fakeMessage(OTHER_CHANNEL), fakeMessage(THREAD));
    expect(discord.deletedPosts).toEqual([]);
    expect(notices(OTHER_CHANNEL)).toEqual([]);
    expect(notices(THREAD)).toEqual([]);
  });

  it('rejects matches the enforcer', async () => {
    const verdicts = new Map<string, boolean>();
    const probe = defineModule({
      name: 'probe',
      optionalDependsOn: [mediaonly],
      listeners: [
        on(Events.MessageCreate, (ctx, message) => {
          verdicts.set(message.id, ctx.modules.optional(mediaonly)!.rejects(message));
        }),
      ],
    });
    await start({ extra: [{ packageName: '@test/probe', definition: probe, config: {} }] });
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: OTHER_CHANNEL, requireSpoiler: true });
    await insertRule(t, { channelId: THREAD, enabled: false });
    await ready(mb!);
    const fixtures = {
      textOnly: fakeMessage(CHANNEL),
      attachment: fakeMessage(CHANNEL, { content: '', attachments: [false] }),
      link: fakeMessage(CHANNEL, { content: 'https://example.com/a.png' }),
      bot: fakeMessage(CHANNEL, { bot: true }),
      webhook: fakeMessage(CHANNEL, { member: null, bot: true, webhookId: '100000000000000777' }),
      system: fakeMessage(CHANNEL, { system: true }),
      exempt: fakeMessage(CHANNEL, { member: fakeMember(MEMBER, { exempt: true }) }),
      unspoilered: fakeMessage(OTHER_CHANNEL, { content: '', attachments: [false] }),
      spoilered: fakeMessage(OTHER_CHANNEL, { content: '||https://example.com/a||', attachments: [true] }),
      disabled: fakeMessage(THREAD),
      memberless: fakeMessage(CHANNEL, { member: null }),
    };
    await say(...Object.values(fixtures));
    const deleted = new Set(discord.deletedPosts);
    const byName = (map: (id: string) => boolean) => Object.fromEntries(Object.entries(fixtures).map(([name, message]) => [name, map(message.id)]));
    expect(byName((id) => verdicts.get(id)!)).toEqual(byName((id) => deleted.has(id)));
    expect(byName((id) => deleted.has(id))).toEqual({
      textOnly: true, attachment: false, link: false, bot: false, webhook: false, system: false, exempt: false,
      unspoilered: true, spoilered: false, disabled: false, memberless: false,
    });
  });
});

describe('rule lifecycle', () => {
  it('removes the rule when its channel or thread is deleted', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: THREAD });
    await ready(mb!);
    mb!.client.emit(Events.ChannelDelete, (await mb!.client.channels.fetch(CHANNEL)) as never);
    mb!.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id: THREAD, guild_id: GUILD, parent_id: CHANNEL, type: 11 }, s: 1 }, 0);
    await mb!.bot.idle();
    expect(await ruleRows(t)).toEqual([]);
    await say(fakeMessage(CHANNEL), fakeMessage(THREAD));
    expect(discord.deletedPosts).toEqual([]);
  });
});
