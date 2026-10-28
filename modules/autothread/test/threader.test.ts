import { FakeDiscordHttp } from '@bronto/core/testing';
import { templatesEvents, templatesGates } from '@bronto/templates';
import { Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { threadName } from '../src/threader.js';
import {
  asTemplates,
  CHANNEL,
  channelOption,
  createTemplate,
  fakeMessage,
  GUILD,
  insertRule,
  MEMBER,
  NEWS,
  prepareAutothreadBot,
  ready,
  runCommand,
  USER,
  type AutothreadBot,
} from './harness.js';

describe('threadName', () => {
  const values = { 'user.display': 'Mia' };

  it('fills the default format', () => {
    expect(threadName('[Comments] {user.display}', values)).toBe('[Comments] Mia');
  });

  it('cuts to 100 characters, counting code points', () => {
    expect(threadName('x'.repeat(150), values)).toBe('x'.repeat(100));
    const cut = threadName('\u{1F600}'.repeat(150), values);
    expect([...cut]).toHaveLength(100);
  });

  it('trims, and uses Comments when nothing is left', () => {
    expect(threadName('  {user.display}  ', values)).toBe('Mia');
    expect(threadName('   ', values)).toBe('Comments');
    expect(threadName('{user.display}', { 'user.display': '' })).toBe('Comments');
  });

  it('fills once and leaves unknown keys', () => {
    expect(threadName('{user.display} {nope} {', { 'user.display': '{user.name}', 'user.name': 'x' })).toBe('{user.name} {nope} {');
  });
});

let t: TestDatabase;
let discord: FakeDiscordHttp;
let ab: AutothreadBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await ab?.bot.stop();
  ab = undefined;
  await t.drop();
});

async function start(options: { sticky?: boolean; mediaonly?: boolean } = {}): Promise<AutothreadBot> {
  ab = await prepareAutothreadBot(t, discord, options);
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

const threadsOf = (parentId: string) =>
  [...discord.channels.values()].filter((channel) => 'parent_id' in channel && channel.parent_id === parentId) as unknown as {
    id: string;
    name: string;
    rate_limit_per_user?: number;
  }[];
const postsIn = (channelId: string) => [...discord.messages.values()].filter((message) => message.channel_id === channelId);

describe('opening threads', () => {
  it('opens a named thread', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { displayName: 'Mia Display' });
    await say(message);
    expect(threadsOf(CHANNEL)).toEqual([expect.objectContaining({ id: message.id, name: '[Comments] Mia Display' })]);
    expect(postsIn(message.id)).toEqual([]);
  });

  it('fills the channel name and UTC date into the thread name', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, nameFormat: '{channel.name} {date.iso}' });
    await ready(ab!);
    const message = { ...fakeMessage(CHANNEL), createdTimestamp: Date.UTC(2026, 9, 27, 23, 30) };
    await say(message);
    expect(threadsOf(CHANNEL)).toEqual([expect.objectContaining({ name: 'general 2026-10-27' })]);
  });

  it('opens threads in announcement channels', async () => {
    await start();
    await insertRule(t, { channelId: NEWS, nameFormat: 'Talk' });
    await ready(ab!);
    await say(fakeMessage(NEWS));
    expect(threadsOf(NEWS)).toEqual([expect.objectContaining({ name: 'Talk' })]);
  });

  it('sets slowmode', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, slowmodeSeconds: 30 });
    await ready(ab!);
    await say(fakeMessage(CHANNEL));
    expect(threadsOf(CHANNEL)[0]).toMatchObject({ rate_limit_per_user: 30 });
  });

  it('posts the auto-message with placeholders, pinging only the author', async () => {
    await start();
    const template = await createTemplate(ab!, 'Welcome', 'Hi {user.mention}, see {message.link} in {channel.mention}.', {
      title: 'Welcome to {server.name}',
    });
    await insertRule(t, { channelId: CHANNEL, templateId: template });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    await say(message);
    const [first] = postsIn(message.id);
    expect(first).toMatchObject({
      content: `Hi <@${MEMBER}>, see ${message.url} in <#${CHANNEL}>.`,
      embeds: [{ title: 'Welcome to Test server' }],
      allowed_mentions: { users: [MEMBER] },
    });
    expect(postsIn(message.id)).toHaveLength(1);
  });

  it('opens a thread without a template and posts nothing in it', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    await say(message);
    expect(threadsOf(CHANNEL)).toHaveLength(1);
    expect(postsIn(message.id)).toEqual([]);
  });

  it('missing template still threads', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, templateId: '00000000-0000-4000-8000-000000000000' });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    await say(message);
    expect(threadsOf(CHANNEL)).toHaveLength(1);
    expect(postsIn(message.id)).toEqual([]);
    expect(ab!.lines.filter((line) => line.level === 40 && line.msg === 'The auto-message template no longer exists')).toHaveLength(1);
  });

  it('logs a failed thread and posts no auto-message', async () => {
    await start();
    const template = await createTemplate(ab!, 'Welcome', 'Hi');
    await insertRule(t, { channelId: CHANNEL, templateId: template });
    await ready(ab!);
    const message = fakeMessage(CHANNEL);
    discord.addPost(message.channelId, message.id);
    discord.override('POST', `/channels/${CHANNEL}/messages/${message.id}/threads`, () => ({
      status: 403,
      json: { code: 50013, message: 'Missing Permissions' },
    }));
    ab!.client.emit(Events.MessageCreate, message);
    await ab!.bot.idle();
    expect(threadsOf(CHANNEL)).toEqual([]);
    expect(ab!.lines.filter((line) => line.level === 40 && line.msg === 'Starting a thread failed')).toHaveLength(1);
  });
});

describe('which posts get a thread', () => {
  it('ignores channels without a rule, disabled rules and system messages', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, enabled: false });
    await insertRule(t, { channelId: NEWS });
    await ready(ab!);
    await say(fakeMessage(CHANNEL), fakeMessage(NEWS, { system: true }));
    expect([...threadsOf(CHANNEL), ...threadsOf(NEWS)]).toEqual([]);
  });

  it('ignores bots by default and threads them without', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: NEWS, ignoreBots: false });
    await ready(ab!);
    const bot = fakeMessage(CHANNEL, { bot: true });
    const webhook = fakeMessage(CHANNEL, { bot: true, webhookId: '100000000000000777' });
    const allowed = fakeMessage(NEWS, { bot: true });
    await say(bot, webhook, allowed);
    expect(threadsOf(CHANNEL)).toEqual([]);
    expect(threadsOf(NEWS).map((thread) => thread.id)).toEqual([allowed.id]);
  });

  it('posts no rename button on the thread of a bot or webhook post', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false, rename: true });
    await ready(ab!);
    const bot = fakeMessage(CHANNEL, { bot: true });
    const webhook = fakeMessage(CHANNEL, { bot: true, webhookId: '100000000000000777' });
    await say(bot, webhook);
    expect(threadsOf(CHANNEL).map((thread) => thread.id).sort()).toEqual([bot.id, webhook.id].sort());
    const inThreads = [...discord.messages.values()].filter((m) => m.channel_id === bot.id || m.channel_id === webhook.id);
    expect(inThreads.filter((m) => (m as unknown as { components?: unknown[] }).components?.length)).toEqual([]);
  });

  it('never threads its own posts, also with ignore-bots off', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(ab!);
    await say(fakeMessage(CHANNEL, { authorId: discord.botId, bot: true }));
    expect(threadsOf(CHANNEL)).toEqual([]);
  });

  it("skips the sticky's own post", async () => {
    await start({ sticky: true });
    discord.addMember(GUILD, USER);
    await insertRule(t, { channelId: CHANNEL, ignoreBots: false });
    await ready(ab!);
    const template = await createTemplate(ab!, 'Rules', 'Read the rules.');
    await runCommand(ab!, 'sticky', 'create', { channel: channelOption(CHANNEL), template });
    const stickyWebhook = discord.sent[0]!.webhookId;
    const stickyPost = fakeMessage(CHANNEL, { bot: true, webhookId: stickyWebhook });
    const otherWebhook = fakeMessage(CHANNEL, { bot: true, webhookId: '100000000000000777' });
    await say(stickyPost, otherWebhook);
    expect(threadsOf(CHANNEL).map((thread) => thread.id)).toEqual([otherWebhook.id]);
  });

  // Listeners run concurrently; `rejects()` is a pure check, so the outcome is the same whichever listener runs first.
  describe('with mediaonly', () => {
    beforeEach(async () => {
      await start({ mediaonly: true });
      await insertRule(t, { channelId: CHANNEL });
      await ready(ab!);
      await runCommand(ab!, 'mediaonly', 'set');
    });

    it('skips posts mediaonly rejects', async () => {
      const text = fakeMessage(CHANNEL, { content: 'Only words' });
      const media = fakeMessage(CHANNEL, { content: 'Look', attachments: 1 });
      await say(text, media);
      expect(discord.deletedPosts).toEqual([text.id]);
      expect(threadsOf(CHANNEL).map((thread) => thread.id)).toEqual([media.id]);
    });

    it('skips posts mediaonly rejects but cannot delete', async () => {
      const text = fakeMessage(CHANNEL, { content: 'Only words' });
      discord.override('DELETE', `/channels/${CHANNEL}/messages/${text.id}`, () => ({
        status: 403,
        json: { code: 50013, message: 'Missing Permissions' },
      }));
      await say(text);
      expect(discord.deletedPosts).toEqual([]);
      expect(threadsOf(CHANNEL)).toEqual([]);
    });
  });
});

describe('templates', () => {
  it('refuses deleting a used template', async () => {
    await start();
    const used = await createTemplate(ab!, 'Used', 'Hi');
    const free = await createTemplate(ab!, 'Free', 'Hi');
    await insertRule(t, { channelId: NEWS, templateId: used });
    await insertRule(t, { channelId: CHANNEL, templateId: used });
    await ready(ab!);
    let denied: unknown;
    let allowed: unknown;
    await asTemplates(ab!, async (ctx) => {
      denied = await ctx.check(templatesGates.deleting, { id: used });
      allowed = await ctx.check(templatesGates.deleting, { id: free });
    });
    expect(denied).toEqual({ allowed: false, reasons: [`Used by the auto-threads in <#${CHANNEL}>, <#${NEWS}>`] });
    expect(allowed).toEqual({ allowed: true });
  });

  it('clears a deleted template', async () => {
    await start();
    const template = await createTemplate(ab!, 'Welcome', 'Hi');
    await insertRule(t, { channelId: CHANNEL, templateId: template });
    await insertRule(t, { channelId: NEWS });
    await ready(ab!);
    await t.database.adminPool.query('delete from templates.templates where id = $1', [template]);
    await asTemplates(ab!, async (ctx) => {
      await ctx.emit(templatesEvents.deleted, { id: template });
    });
    const { rows } = await t.database.adminPool.query('select channel_id, template_id from autothread.rules order by channel_id');
    expect(rows).toEqual([
      { channel_id: CHANNEL, template_id: null },
      { channel_id: NEWS, template_id: null },
    ]);
    // The index is cleared too: the next post threads without a message and without a warning.
    const message = fakeMessage(CHANNEL);
    await say(message);
    expect(postsIn(message.id)).toEqual([]);
    expect(ab!.lines.filter((line) => line.msg === 'The auto-message template no longer exists')).toEqual([]);
  });
});
