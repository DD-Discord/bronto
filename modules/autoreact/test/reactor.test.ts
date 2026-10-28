import { defineModule, type HandlerContext } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import templates from '@bronto/templates';
import { Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import {
  CHANNEL,
  channelOption,
  CUSTOM,
  CUSTOM_EMOJI,
  fakeMessage,
  GUILD,
  IGNORED,
  insertRule,
  OTHER_CHANNEL,
  prepareAutoreactBot,
  ready,
  ruleRows,
  runCommand,
  THREAD,
  USER,
  type AutoreactBot,
} from './harness.js';

const THUMBS = '\u{1F44D}';
const PARTY = '\u{1F389}';
const FIRE = '\u{1F525}';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let ab: AutoreactBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await ab?.bot.stop();
  ab = undefined;
  await t.drop();
});

async function start(options: { sticky?: boolean; mediaonly?: boolean } = {}): Promise<AutoreactBot> {
  ab = await prepareAutoreactBot(t, discord, options);
  return ab;
}

/** Sends messages the way the gateway does: each into the fake channel, then as an event. */
async function say(...messages: ReturnType<typeof fakeMessage>[]): Promise<void> {
  for (const message of messages) {
    discord.addPost(message.channelId, message.id, { content: message.content, attachmentCount: message.attachments.size });
    ab!.client.emit(Events.MessageCreate, message);
  }
  await ab!.bot.idle();
}

const reacted = (message: { id: string }) => discord.reactions.filter((r) => r.messageId === message.id).map((r) => r.emoji);

describe('reacting', () => {
  it('reacts in order', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, emojis: [THUMBS, PARTY, CUSTOM] });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    await say(message);
    expect(reacted(message)).toEqual([THUMBS, PARTY, `party:${CUSTOM_EMOJI}`]);
  });

  it('continues after a failed reaction', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, emojis: [THUMBS, PARTY, FIRE] });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    discord.addPost(message.channelId, message.id);
    discord.override('PUT', `/channels/${CHANNEL}/messages/${message.id}/reactions/${encodeURIComponent(PARTY)}/@me`, () => ({
      status: 400,
      json: { code: 10014, message: 'Unknown Emoji' },
    }));
    await say(message);
    expect(reacted(message)).toEqual([THUMBS, FIRE]);
    expect(ab!.lines.filter((line) => line.level === 40 && line.msg === 'Adding a reaction failed')).toHaveLength(1);
  });

  it('ignores channels without a rule, disabled rules and system messages', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, enabled: false });
    await insertRule(t, { channelId: OTHER_CHANNEL });
    await ready(ab!);
    const disabled = fakeMessage(CHANNEL);
    const system = fakeMessage(OTHER_CHANNEL, { system: true });
    const unruled = fakeMessage(THREAD);
    await say(disabled, system, unruled);
    expect(discord.reactions).toEqual([]);
  });

  it('skips ignored users', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, ignoredUserIds: [IGNORED] });
    await ready(ab!);
    const ignored = fakeMessage(CHANNEL, { authorId: IGNORED });
    const other = fakeMessage(CHANNEL);
    await say(ignored, other);
    expect(reacted(ignored)).toEqual([]);
    expect(reacted(other)).toEqual([THUMBS]);
  });

  it('skips bots and webhooks with ignore-bots, reacts to them without', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: OTHER_CHANNEL, ignoreBots: false });
    await ready(ab!);
    const bot = fakeMessage(CHANNEL, { bot: true });
    const webhook = fakeMessage(CHANNEL, { bot: true, webhookId: '100000000000000777' });
    const allowedBot = fakeMessage(OTHER_CHANNEL, { bot: true });
    const allowedWebhook = fakeMessage(OTHER_CHANNEL, { bot: true, webhookId: '100000000000000777' });
    await say(bot, webhook, allowedBot, allowedWebhook);
    expect(discord.reactions.map((r) => r.messageId)).toEqual([allowedBot.id, allowedWebhook.id]);
  });

  it('never reacts to its own posts, also with ignore-bots off', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(ab!);
    const own = fakeMessage(CHANNEL, { authorId: discord.botId, bot: true });
    await say(own);
    expect(discord.reactions).toEqual([]);
  });

  it("skips the sticky's own post", async () => {
    await start({ sticky: true });
    discord.addMember(GUILD, USER);
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(ab!);
    const runtime = ab!.bot.runtimes.find((entry) => entry.name === 'sticky')!;
    let template = '';
    const outcome = await ab!.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx: HandlerContext) => {
      template = (await ctx.modules.get(templates).create({ name: 'Rules', content: 'Read the rules.', embed: null })).id;
    });
    expect(outcome.ok).toBe(true);
    await runCommand(ab!, 'sticky', 'create', { channel: channelOption(CHANNEL), template });
    const stickyWebhook = discord.sent[0]!.webhookId;

    const stickyPost = fakeMessage(CHANNEL, { bot: true, webhookId: stickyWebhook });
    const otherWebhook = fakeMessage(CHANNEL, { bot: true, webhookId: '100000000000000777' });
    await say(stickyPost, otherWebhook);
    expect(reacted(stickyPost)).toEqual([]);
    expect(reacted(otherWebhook)).toEqual([THUMBS]);
  });

  // The loader starts a module after the optional dependencies it names, so mediaonly's listener always runs first
  // and has already deleted the post (or failed to) when autoreact looks at it.
  describe('with mediaonly', () => {
    beforeEach(async () => {
      await start({ mediaonly: true });
      await insertRule(t, { channelId: CHANNEL });
      await ready(ab!);
      await runCommand(ab!, 'mediaonly', 'set');
    });

    it('skips posts mediaonly deletes', async () => {
      const text = fakeMessage(CHANNEL, { content: 'Only words' });
      const media = fakeMessage(CHANNEL, { content: 'Look', attachments: 1 });
      await say(text, media);
      expect(discord.deletedPosts).toEqual([text.id]);
      expect(reacted(text)).toEqual([]);
      expect(reacted(media)).toEqual([THUMBS]);
    });

    it('skips posts mediaonly rejects but cannot delete', async () => {
      const text = fakeMessage(CHANNEL, { content: 'Only words' });
      discord.override('DELETE', `/channels/${CHANNEL}/messages/${text.id}`, () => ({
        status: 403,
        json: { code: 50013, message: 'Missing Permissions' },
      }));
      await say(text);
      expect(discord.deletedPosts).toEqual([]);
      expect(reacted(text)).toEqual([]);
    });
  });

  it('applies a rule on a thread to that thread only', async () => {
    await start();
    await insertRule(t, { channelId: THREAD });
    await ready(ab!);
    const inThread = fakeMessage(THREAD);
    const inParent = fakeMessage(CHANNEL);
    await say(inThread, inParent);
    expect(reacted(inThread)).toEqual([THUMBS]);
    expect(reacted(inParent)).toEqual([]);
  });

  it('does not apply a channel rule to its threads', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const inThread = fakeMessage(THREAD);
    const inChannel = fakeMessage(CHANNEL);
    await say(inThread, inChannel);
    expect(reacted(inThread)).toEqual([]);
    expect(reacted(inChannel)).toEqual([THUMBS]);
  });

  it('removes the rule of a deleted channel or thread', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: THREAD });
    await ready(ab!);
    ab!.client.emit(Events.ChannelDelete, (await ab!.client.channels.fetch(CHANNEL)) as never);
    ab!.client.emit(Events.Raw, { op: 0, t: 'THREAD_DELETE', d: { id: THREAD, guild_id: GUILD, parent_id: CHANNEL, type: 11 }, s: 1 }, 0);
    await ab!.bot.idle();
    expect(await ruleRows(t)).toEqual([]);
    await say(fakeMessage(CHANNEL), fakeMessage(THREAD));
    expect(discord.reactions).toEqual([]);
  });
});
