import { defineModule, on } from '@bronto/core';
import type { TemplatesApi } from '@bronto/templates';
import { ChannelType, Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { stickyEvents } from '../src/events.js';
import { Reposter, type StickyContext } from '../src/repost.js';
import { StickyIndex } from '../src/sticky-index.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import {
  CHANNEL,
  GUILD,
  insertSticky,
  message,
  prepareStickyBot,
  QUIET_CHANNEL,
  ready,
  setState,
  sleep,
  stateOf,
  stickyRows,
  THREAD,
  type StickyBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
const bots: StickyBot[] = [];

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  for (const { bot } of bots.splice(0)) await bot.stop();
  vi.useRealTimers();
  await t.drop();
});

async function start(options?: Parameters<typeof prepareStickyBot>[2]): Promise<StickyBot> {
  const sb = await prepareStickyBot(t, discord, options);
  bots.push(sb);
  return sb;
}

async function say(sb: StickyBot, ...messages: ReturnType<typeof message>[]): Promise<void> {
  for (const sent of messages) sb.client.emit(Events.MessageCreate, sent);
  await sb.bot.idle();
}

describe('reposting', () => {
  it('reposts below every new message and records the post', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(sb, message(CHANNEL));
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]).toMatchObject({
      webhookId: sticky.webhookId,
      threadId: null,
      message: { content: 'Read the rules.', embeds: [] },
      options: { silent: true, username: 'Sticky' },
    });
    expect(sb.requests.find(request => request.method === 'POST' && request.path.startsWith('/webhooks/'))).toMatchObject({
      authorized: false,
      body: { allowed_mentions: { parse: [] }, flags: 4096, username: 'Sticky' },
    });
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(discord.sent[0]!.id);
    await say(sb, message(CHANNEL));
    expect(discord.deleted).toEqual([discord.sent[0]!.id]);
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[1]!.id]);
  });

  it('ignores its own posts, other channels, and bots unless told otherwise', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(
      sb,
      message(CHANNEL, { webhookId: sticky.webhookId, bot: true }),
      message(QUIET_CHANNEL),
      message(CHANNEL, { bot: true }),
      message(CHANNEL, { system: true }),
    );
    expect(discord.sent).toEqual([]);
  });

  it('reacts to bots when ignore-bots is off, but never to its own posts', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL, ignoreBots: false });
    await ready(sb);
    await say(sb, message(CHANNEL, { webhookId: sticky.webhookId, bot: true }));
    expect(discord.sent).toEqual([]);
    await say(sb, message(CHANNEL, { bot: true }));
    expect(discord.sent).toHaveLength(1);
  });

  it('posts into threads through the parent channel webhook', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL });
    await ready(sb);
    await say(sb, message(THREAD));
    expect(discord.sent[0]).toMatchObject({ channelId: CHANNEL, threadId: THREAD });
  });

  it('skips stickies whose template is missing and that have no stored copy', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL, content: null, embeds: null });
    // Start-up deletes stickies whose template is already gone, so the template goes missing only afterwards.
    const api = sb.bot.runtimes.find((entry) => entry.name === 'templates')!.api as TemplatesApi;
    const get = vi.spyOn(api, 'get').mockResolvedValue({ id: sticky.templateId, name: 'Rules', url: 'https://discord.com/channels/1/2' });
    await ready(sb);
    get.mockRestore();
    await say(sb, message(CHANNEL));
    expect(discord.sent).toEqual([]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 20, msg: "Skipped a repost: the sticky's template doesn't exist", channelId: CHANNEL }));
  });

  it('ends a burst with the sticky below the newest message and every earlier post deleted', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const path = `/webhooks/${sticky.webhookId}/${sticky.webhookToken}`;
    discord.override('POST', path, async request => {
      reached.resolve(); await gate.promise; discord.clearOverride('POST', path); return discord.answer(request);
    });
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await reached.promise;
    for (let i = 0; i < 9; i++) sb.client.emit(Events.MessageCreate, message(CHANNEL));
    const lastMessageAt = performance.now();
    gate.resolve();
    await sb.bot.idle();
    const live = discord.liveMessages(CHANNEL);
    expect(live).toHaveLength(1);
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(live[0]);
    expect(discord.sent.at(-1)!.id).toBe(live[0]);
    expect(discord.sent.length).toBeGreaterThanOrEqual(2);
    expect(discord.sent.length).toBeLessThanOrEqual(3);
    expect(discord.sent.at(-1)!.startedAt).toBeGreaterThanOrEqual(lastMessageAt);
    for (const post of discord.sent.slice(0, -1)) expect(discord.deleted).toContain(post.id);
  });

  it('treats a post deleted by hand as gone', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL });
    await setState(t, CHANNEL, { lastMessageId: '100000000000009999' });
    await ready(sb);
    await say(sb, message(CHANNEL));
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[0]!.id]);
    expect(sb.lines.filter((line) => line.level >= 40)).toEqual([]);
  });

  it('replaces a webhook deleted by hand and posts once more', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(sb, message(CHANNEL));
    const first = discord.sent[0]!.id;
    discord.removeWebhook(sticky.webhookId);
    await say(sb, message(CHANNEL));
    const [row] = await stickyRows(t);
    expect(row!.webhookId).not.toBe(sticky.webhookId);
    expect(discord.webhooks.has(row!.webhookId)).toBe(true);
    expect(discord.botDeleted).toEqual([first]);
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[1]!.id]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ msg: 'Replaced the deleted webhook of a sticky' }));
    await say(sb, message(CHANNEL));
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[2]!.id]);
  });

  it('still reposts when deleting the old post after a webhook replacement fails', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(sb, message(CHANNEL));
    discord.removeWebhook(sticky.webhookId);
    discord.override('DELETE', `/channels/${CHANNEL}/messages/${discord.sent[0]!.id}`, () => { throw new Error('boom'); });
    await say(sb, message(CHANNEL));
    expect(discord.sent).toHaveLength(2);
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(discord.sent[1]!.id);
    expect(sb.lines).toContainEqual(
      expect.objectContaining({ level: 40, channelId: CHANNEL, msg: 'Deleting the previous sticky post failed' }),
    );
  });

  it('logs the new post when recording it fails', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    const errors: unknown[][] = [];
    let runs = 0;
    const ctx = {
      guildId: GUILD,
      client: sb.client,
      config: { webhookName: 'Sticky' },
      log: { warn: () => undefined, info: () => undefined, error: (...args: unknown[]) => void errors.push(args) },
      emit: () => undefined,
      // No template: the stored copy is posted.
      modules: { get: () => ({ render: async () => null }) },
      db: {
        run: async () => {
          runs += 1;
          if (runs === 1) return { sticky, lastMessageId: null };
          throw new Error('database down');
        },
      },
    } as unknown as StickyContext;
    const reposter = new Reposter({ index: new StickyIndex() });
    await expect(reposter.repost(ctx, CHANNEL)).rejects.toThrow('database down');
    expect(errors).toEqual([
      [
        expect.objectContaining({ channelId: CHANNEL, messageId: discord.sent[0]!.id }),
        'Recording the new sticky post failed',
      ],
    ]);
  });

  it('announces each post', async () => {
    const seen: string[] = [];
    const listener = defineModule({
      name: 'listener',
      listeners: [
        on(stickyEvents.posted, (_ctx, payload) => {
          seen.push(payload.messageId);
        }),
      ],
    });
    const sb = await start({ extra: [{ packageName: '@test/listener', definition: listener, config: {} }] });
    await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(sb, message(CHANNEL));
    expect(seen).toEqual([discord.sent[0]!.id]);
  });
});

describe('debounce', () => {
  it('waits for quiet before reposting', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 80 });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await ready(sb);
    for (let i = 0; i < 3; i++) {
      await say(sb, message(CHANNEL));
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(discord.sent).toEqual([]);
    expect((await stateOf(t, CHANNEL))?.repostDueAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(150);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    expect((await stateOf(t, CHANNEL))?.repostDueAt).toBeNull();
  });

  it('posts an overdue repost right after start-up, once', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 60_000 });
    await setState(t, CHANNEL, { repostDueAt: new Date(Date.now() - 1000) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await ready(sb);
    await vi.advanceTimersByTimeAsync(30);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(discord.sent).toHaveLength(1);
  });

  it('keeps the remaining wait of a repost due later', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 60_000 });
    await setState(t, CHANNEL, { repostDueAt: new Date(Date.now() + 120) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await ready(sb);
    await vi.advanceTimersByTimeAsync(40);
    expect(discord.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(160);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });

  it('stops a pending repost when the module is switched off, and honours it when switched back on', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 80 });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await ready(sb);
    await say(sb, message(CHANNEL));
    await sb.bot.lifecycle.setModuleEnabled(GUILD, 'sticky', false, null);
    await vi.advanceTimersByTimeAsync(150);
    await sb.bot.idle();
    expect(discord.sent).toEqual([]);
    await say(sb, message(CHANNEL));
    expect(discord.sent).toEqual([]);
    await sb.bot.lifecycle.setModuleEnabled(GUILD, 'sticky', true, null);
    await vi.advanceTimersByTimeAsync(30);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });
});

describe('debounce and index changes', () => {
  const entry = { guildId: GUILD, channelId: CHANNEL, webhookId: '100000000000000040', ignoreBots: true, debounceMs: 10 };

  /** Runs onMessage with `change` applied to the index while the due time is written. */
  async function armedRuns(change: (index: StickyIndex) => void): Promise<string[]> {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const index = new StickyIndex();
    index.set(entry);
    const reposter = new Reposter({ index });
    const runs: string[] = [];
    const ctx = {
      guildId: GUILD,
      db: { run: async () => change(index) },
      queue: { run: async (key: string) => void runs.push(key) },
    } as unknown as StickyContext;
    await reposter.onMessage(ctx, message(CHANNEL));
    await vi.advanceTimersByTimeAsync(40);
    reposter.cancel(CHANNEL);
    return runs;
  }

  it('still arms the debounce when the entry is replaced meanwhile', async () => {
    expect(await armedRuns((index) => index.updateWebhook(CHANNEL, '100000000000000041'))).toEqual([CHANNEL]);
  });

  it('does not arm the debounce when the sticky is deleted meanwhile', async () => {
    expect(await armedRuns((index) => index.delete(CHANNEL))).toEqual([]);
  });
});

describe('guild deletion', () => {
  it('deletes stored guild data without deleting Discord posts or webhooks', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await insertSticky(t, discord, { channelId: THREAD, parentChannelId: CHANNEL, webhookId: sticky.webhookId, webhookToken: sticky.webhookToken });
    await ready(sb);
    await say(sb, message(CHANNEL), message(THREAD));
    const messages = discord.liveMessages();
    const webhooks = [...discord.webhooks.keys()];
    const calls = [...sb.requests];
    expect(discord.sent).toHaveLength(2);
    await sb.bot.lifecycle.deleteGuild(GUILD);
    expect(await stickyRows(t)).toEqual([]);
    expect(discord.liveMessages()).toEqual(messages);
    expect([...discord.webhooks.keys()]).toEqual(webhooks);
    expect(sb.requests).toEqual(calls);
  });

  it('retains data before 30 days and purges it afterwards without Discord cleanup', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    await say(sb, message(CHANNEL));
    const messages = discord.liveMessages();
    const calls = [...sb.requests];
    const leftAt = new Date('2026-01-01T00:00:00Z');
    await sb.bot.lifecycle.leave(GUILD, leftAt);
    expect(await sb.bot.lifecycle.purgeDueGuilds(new Date('2026-01-30T00:00:00Z'))).toEqual([]);
    expect(await stickyRows(t)).toHaveLength(1);
    expect(await sb.bot.lifecycle.purgeDueGuilds(new Date('2026-01-31T00:00:00Z'))).toEqual([GUILD]);
    expect(await stickyRows(t)).toEqual([]);
    expect(discord.liveMessages()).toEqual(messages);
    expect(sb.requests).toEqual(calls);
  });
});

it.each([10015, 50027])('recovers webhook error %i between resolution and send', async code => {
  const sb = await start();
  const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
  await ready(sb);
  const path = `/webhooks/${sticky.webhookId}/${sticky.webhookToken}`;
  discord.override('POST', path, () => {
    discord.removeWebhook(sticky.webhookId);
    return { status: code === 50027 ? 401 : 404, json: { code, message: 'Unusable webhook' } };
  });
  await say(sb, message(CHANNEL));
  expect(discord.sent).toHaveLength(1);
  expect((await stickyRows(t))[0]!.webhookId).not.toBe(sticky.webhookId);
});

it('isolates native clients and stops pending reposts after guild departure', async () => {
  const sb = await start();
  await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 80 });
  await ready(sb);
  const otherDb = await createTestDatabase();
  const otherHttp = new FakeDiscordHttp();
  const other = await prepareStickyBot(otherDb, otherHttp);
  try {
    await insertSticky(otherDb, otherHttp, { channelId: CHANNEL });
    await ready(other);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await say(sb, message(CHANNEL));
    await sb.bot.lifecycle.leave(GUILD);
    const requests = sb.requests.length;
    await vi.advanceTimersByTimeAsync(150);
    await sb.bot.idle();
    expect(discord.sent).toEqual([]);
    expect(sb.requests).toHaveLength(requests);
    await say(other, message(CHANNEL));
    expect(otherHttp.sent).toHaveLength(1);
  } finally {
    await other.bot.stop();
    vi.useRealTimers();
    await otherDb.drop();
  }
});
