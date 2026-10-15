import { defineModule, on } from '@bronto/core';
import { Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { stickyEvents } from '../src/events.js';
import { Reposter, type StickyContext } from '../src/repost.js';
import { StickyIndex } from '../src/sticky-index.js';
import { FakeStickyDiscord } from './fake-discord.js';
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
let discord: FakeStickyDiscord;
const bots: StickyBot[] = [];

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeStickyDiscord();
});

afterEach(async () => {
  for (const { bot } of bots.splice(0)) await bot.stop();
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

  it('ends a burst with the sticky below the newest message and every earlier post deleted', async () => {
    discord.sendDelayMs = 25;
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL });
    await ready(sb);
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    for (let waited = 0; !discord.calls.includes('send'); waited += 1) {
      if (waited > 2000) throw new Error('The first repost never started sending');
      await sleep(1);
    }
    for (let i = 0; i < 9; i++) sb.client.emit(Events.MessageCreate, message(CHANNEL));
    const lastMessageAt = performance.now();
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
    discord.failDeleteChannelMessage = true;
    await say(sb, message(CHANNEL));
    expect(discord.sent).toHaveLength(2);
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(discord.sent[1]!.id);
    expect(sb.lines).toContainEqual(
      expect.objectContaining({ level: 40, channelId: CHANNEL, msg: 'Deleting the previous sticky post failed' }),
    );
  });

  it('logs the new post when recording it fails', async () => {
    await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    const errors: unknown[][] = [];
    let runs = 0;
    const ctx = {
      guildId: GUILD,
      config: { webhookName: 'Sticky' },
      log: { warn: () => undefined, info: () => undefined, error: (...args: unknown[]) => void errors.push(args) },
      emit: () => undefined,
      db: {
        run: async () => {
          runs += 1;
          if (runs === 1) return { sticky, lastMessageId: null };
          throw new Error('database down');
        },
      },
    } as unknown as StickyContext;
    const reposter = new Reposter({ index: new StickyIndex(), discord: () => discord });
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
    await ready(sb);
    for (let i = 0; i < 3; i++) {
      await say(sb, message(CHANNEL));
      await sleep(10);
    }
    expect(discord.sent).toEqual([]);
    expect((await stateOf(t, CHANNEL))?.repostDueAt).not.toBeNull();
    await sleep(150);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    expect((await stateOf(t, CHANNEL))?.repostDueAt).toBeNull();
  });

  it('posts an overdue repost right after start-up, once', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 60_000 });
    await setState(t, CHANNEL, { repostDueAt: new Date(Date.now() - 1000) });
    await ready(sb);
    await sleep(30);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    await sleep(30);
    expect(discord.sent).toHaveLength(1);
  });

  it('keeps the remaining wait of a repost due later', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 60_000 });
    await setState(t, CHANNEL, { repostDueAt: new Date(Date.now() + 120) });
    await ready(sb);
    await sleep(40);
    expect(discord.sent).toEqual([]);
    await sleep(160);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });

  it('stops a pending repost when the module is switched off, and honours it when switched back on', async () => {
    const sb = await start();
    await insertSticky(t, discord, { channelId: CHANNEL, debounceMs: 80 });
    await ready(sb);
    await say(sb, message(CHANNEL));
    await sb.bot.lifecycle.setModuleEnabled(GUILD, 'sticky', false, null);
    await sleep(150);
    await sb.bot.idle();
    expect(discord.sent).toEqual([]);
    await say(sb, message(CHANNEL));
    expect(discord.sent).toEqual([]);
    await sb.bot.lifecycle.setModuleEnabled(GUILD, 'sticky', true, null);
    await sleep(30);
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
  });
});

describe('debounce and index changes', () => {
  const entry = { guildId: GUILD, channelId: CHANNEL, webhookId: '100000000000000040', ignoreBots: true, debounceMs: 10 };

  /** Runs onMessage with `change` applied to the index while the due time is written. */
  async function armedRuns(change: (index: StickyIndex) => void): Promise<string[]> {
    const index = new StickyIndex();
    index.set(entry);
    const reposter = new Reposter({ index, discord: () => discord });
    const runs: string[] = [];
    const ctx = {
      guildId: GUILD,
      db: { run: async () => change(index) },
      queue: { run: async (key: string) => void runs.push(key) },
    } as unknown as StickyContext;
    await reposter.onMessage(ctx, message(CHANNEL));
    await sleep(40);
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
  it('removes posts and webhooks from Discord before the rows go', async () => {
    const sb = await start();
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL });
    await insertSticky(t, discord, {
      channelId: THREAD,
      parentChannelId: CHANNEL,
      webhookId: sticky.webhookId,
      webhookToken: sticky.webhookToken,
    });
    await ready(sb);
    await say(sb, message(CHANNEL), message(THREAD));
    expect(discord.liveMessages()).toHaveLength(2);
    await sb.bot.lifecycle.deleteGuild(GUILD);
    expect(discord.liveMessages()).toEqual([]);
    expect(discord.deletedWebhooks).toEqual([sticky.webhookId]);
    expect(await stickyRows(t)).toEqual([]);
  });
});
