import { Events } from 'discord.js';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { cooldowns, posts, rules } from '../src/db/schema.js';
import { FakeAutodeleteDiscord } from './fake-discord.js';
import {
  autodeleteDb,
  bulkDeleted,
  CHANNEL,
  cooldownRows,
  deletedMessage,
  fakeMember,
  fakeMessage,
  GUILD,
  insertCooldown,
  insertPost,
  insertRule,
  MEMBER,
  OTHER_CHANNEL,
  postRows,
  prepareAutodeleteBot,
  ready,
  RecordingNotifier,
  snowflakeAt,
  USER,
  type AutodeleteBot,
} from './harness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-03-01T12:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

let t: TestDatabase;
let discord: FakeAutodeleteDiscord;
let notifier: RecordingNotifier;
let clock: number;
let ab: AutodeleteBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeAutodeleteDiscord();
  notifier = new RecordingNotifier();
  clock = T0.getTime();
});

afterEach(async () => {
  await ab?.bot.stop();
  ab = undefined;
  await t.drop();
});

async function start(): Promise<AutodeleteBot> {
  ab = await prepareAutodeleteBot(t, discord, { notifier, now: () => clock });
  return ab;
}

/** Sends messages the way the gateway does: each into the fake channel, then as an event. */
async function say(...messages: ReturnType<typeof fakeMessage>[]): Promise<void> {
  for (const message of messages) {
    discord.addPost(message.channelId, message.id, { content: message.content, attachmentCount: 0 });
    ab!.client.emit(Events.MessageCreate, message);
  }
  await ab!.bot.idle();
}

async function deleteEvent(channelId: string, messageId: string): Promise<void> {
  ab!.client.emit(Events.MessageDelete, deletedMessage(channelId, messageId));
  await ab!.bot.idle();
}

const errors = () => ab!.lines.filter((line) => line.level >= 50);

describe('new posts', () => {
  it('first post is tracked', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    expect(await postRows(t)).toEqual([
      expect.objectContaining({ guildId: GUILD, channelId: CHANNEL, userId: MEMBER, messageId: message.id, postedAt: at(0) }),
    ]);
    expect(await cooldownRows(t)).toEqual([
      expect.objectContaining({ channelId: CHANNEL, userId: MEMBER, messageId: message.id, postedAt: at(0) }),
    ]);
    expect(notifier.calls).toEqual([]);
    expect(discord.deletedPosts).toEqual([]);
  });

  it('repost with keep-latest deletes the old post and reports it', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0), content: 'Old text' });
    const second = fakeMessage(CHANNEL, { at: at(HOUR), content: 'New text' });
    await say(first);
    await say(second);
    expect(discord.deletedPosts).toEqual([first.id]);
    expect((await postRows(t)).map((row) => row.messageId)).toEqual([second.id]);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: second.id, postedAt: at(HOUR) })]);
    expect(notifier.calls).toEqual([
      {
        kind: 'replaced',
        channelId: CHANNEL,
        member: {
          id: MEMBER,
          displayName: `User ${MEMBER.slice(-3)}`,
          avatarUrl: `https://cdn.example.test/members/${MEMBER}.png`,
          joinedAt: new Date('2025-06-01T00:00:00Z'),
        },
        removed: {
          messageId: first.id,
          postedAt: at(0),
          post: { content: 'Old text', attachmentCount: 0 },
          outcome: 'deleted',
        },
        newPost: { messageId: second.id, content: 'New text' },
      },
    ]);
  });

  it('repost within the cooldown is rejected', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: 7 * DAY });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0), content: 'Old text' });
    const second = fakeMessage(CHANNEL, { at: at(DAY), content: 'New text' });
    await say(first);
    const postsBefore = await postRows(t);
    const cooldownsBefore = await cooldownRows(t);
    await say(second);
    expect(discord.deletedPosts).toEqual([second.id]);
    expect(await postRows(t)).toEqual(postsBefore);
    expect(await cooldownRows(t)).toEqual(cooldownsBefore);
    expect(notifier.calls).toEqual([
      expect.objectContaining({
        kind: 'rejected',
        channelId: CHANNEL,
        rejected: { messageId: second.id, postedAt: at(DAY), post: { content: 'New text', attachmentCount: 0 }, outcome: 'deleted' },
        current: { messageId: first.id, post: { content: 'Old text', attachmentCount: 0 } },
        nextPostAt: at(7 * DAY),
      }),
    ]);
  });

  it('rejects without a current post when the member has none left', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY });
    await insertCooldown(t, { channelId: CHANNEL, userId: MEMBER, postedAt: at(-HOUR) });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    expect(notifier.calls).toEqual([expect.objectContaining({ kind: 'rejected', current: null, nextPostAt: at(DAY - HOUR) })]);
  });

  it('cooldown boundary: a post exactly cooldown_ms later is accepted', async () => {
    await start();
    // Beyond the int32 range of milliseconds.
    const cooldownMs = 28 * DAY;
    await insertRule(t, { channelId: CHANNEL, cooldownMs });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0) });
    const early = fakeMessage(CHANNEL, { at: at(cooldownMs - 1) });
    const onTime = fakeMessage(CHANNEL, { at: at(cooldownMs) });
    await say(first);
    await say(early);
    expect(notifier.calls.map((call) => call.kind)).toEqual(['rejected']);
    await say(onTime);
    expect(notifier.calls.map((call) => call.kind)).toEqual(['rejected', 'replaced']);
    expect((await postRows(t)).map((row) => row.messageId)).toEqual([onTime.id]);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: onTime.id, postedAt: at(cooldownMs) })]);
  });

  it('keep-latest off tracks several posts; leave deletes all of them and the cooldown survives a rejoin', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, keepLatest: false, deleteOnLeave: true, cooldownMs: HOUR });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0) });
    const second = fakeMessage(CHANNEL, { at: at(HOUR) });
    await say(first);
    await say(second);
    expect((await postRows(t)).map((row) => row.messageId).sort()).toEqual([first.id, second.id].sort());
    expect(notifier.calls).toEqual([]);

    ab!.client.emit(Events.GuildMemberRemove, { ...fakeMember(), joinedAt: null });
    await ab!.bot.idle();
    expect(await postRows(t)).toEqual([]);
    expect([...discord.deletedPosts].sort()).toEqual([first.id, second.id].sort());
    expect(notifier.calls).toHaveLength(2);
    expect(notifier.calls.every((call) => call.kind === 'left' && call.member.joinedAt === null)).toBe(true);
    expect(notifier.calls.map((call) => (call.kind === 'left' ? call.removed.messageId : null)).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: second.id, postedAt: at(HOUR) })]);

    const afterRejoin = fakeMessage(CHANNEL, { at: at(HOUR + 30 * 60 * 1000) });
    await say(afterRejoin);
    expect(notifier.calls.at(-1)).toMatchObject({ kind: 'rejected', current: null, nextPostAt: at(2 * HOUR) });
    expect(await postRows(t)).toEqual([]);
  });

  it('leave falls back to the user fields of a partial member', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, deleteOnLeave: true });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    const { user, guild } = fakeMember();
    ab!.client.emit(Events.GuildMemberRemove, { id: MEMBER, guild, user, partial: true, joinedAt: null });
    await ab!.bot.idle();
    expect(notifier.calls).toEqual([
      expect.objectContaining({
        kind: 'left',
        member: {
          id: MEMBER,
          displayName: user.displayName,
          avatarUrl: `https://cdn.example.test/avatars/${MEMBER}.png`,
          joinedAt: null,
        },
      }),
    ]);
  });

  it('leave does nothing without delete-on-leave or for a disabled rule', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: OTHER_CHANNEL, deleteOnLeave: true, enabled: false });
    await insertPost(t, { channelId: CHANNEL, userId: MEMBER, messageId: snowflakeAt(at(0)) });
    await insertPost(t, { channelId: OTHER_CHANNEL, userId: MEMBER, messageId: snowflakeAt(at(1)) });
    await ready(ab!);
    ab!.client.emit(Events.GuildMemberRemove, fakeMember());
    await ab!.bot.idle();
    expect(await postRows(t)).toHaveLength(2);
    expect(discord.calls).toEqual([]);
    expect(notifier.calls).toEqual([]);
  });

  it('two simultaneous posts with a cooldown: exactly one accepted', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY });
    await ready(ab!);
    await say(fakeMessage(CHANNEL, { at: at(0) }), fakeMessage(CHANNEL, { at: at(1) }));
    expect(await postRows(t)).toHaveLength(1);
    expect(await cooldownRows(t)).toHaveLength(1);
    expect(notifier.calls.map((call) => call.kind)).toEqual(['rejected']);
    expect(discord.deletedPosts).toHaveLength(1);
    expect(errors()).toEqual([]);
  });

  it('two simultaneous posts with keep-latest keep the newer one', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const older = fakeMessage(CHANNEL, { at: at(0) });
    const newer = fakeMessage(CHANNEL, { at: at(1) });
    // The newer event is handled first.
    await say(newer, older);
    expect((await postRows(t)).map((row) => row.messageId)).toEqual([newer.id]);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: newer.id })]);
    expect(discord.deletedPosts).toEqual([older.id]);
    expect(notifier.calls).toEqual([
      expect.objectContaining({ kind: 'replaced', removed: expect.objectContaining({ messageId: older.id }) }),
    ]);
  });

  it('already gone: still reports, with post null', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertPost(t, { channelId: CHANNEL, userId: MEMBER, messageId: snowflakeAt(at(-HOUR)), postedAt: at(-HOUR) });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    expect(discord.calls).toEqual(['fetchPost', 'deletePost']);
    expect(notifier.calls).toEqual([
      expect.objectContaining({
        kind: 'replaced',
        removed: { messageId: snowflakeAt(at(-HOUR)), postedAt: at(-HOUR), post: null, outcome: 'gone' },
      }),
    ]);
  });

  it('logs a warning and still reports when deleting is forbidden', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0) });
    await say(first);
    discord.deletePost = async () => 'forbidden';
    await say(fakeMessage(CHANNEL, { at: at(HOUR) }));
    expect(notifier.calls).toEqual([
      expect.objectContaining({ kind: 'replaced', removed: expect.objectContaining({ messageId: first.id, outcome: 'forbidden' }) }),
    ]);
    expect(ab!.lines).toContainEqual(expect.objectContaining({ level: 40, channelId: CHANNEL, messageId: first.id }));
  });

  it('rule deleted mid-flight: nothing is written', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY });
    await ready(ab!);
    // The index still holds the rule.
    await t.database.admin.delete(rules).where(eq(rules.channelId, CHANNEL));
    await say(fakeMessage(CHANNEL, { at: at(0) }));
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toEqual([]);
    expect(notifier.calls).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it('rule disabled mid-flight: nothing is written', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await ready(ab!);
    await t.database.admin.update(rules).set({ enabled: false }).where(eq(rules.channelId, CHANNEL));
    await say(fakeMessage(CHANNEL, { at: at(0) }));
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toEqual([]);
  });

  it('ignores messages without member, bots, webhooks, system messages, exempt members, disabled rules and other channels', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY });
    await insertRule(t, { channelId: OTHER_CHANNEL, enabled: false });
    await ready(ab!);
    await say(
      fakeMessage(CHANNEL, { member: null }),
      fakeMessage(CHANNEL, { bot: true }),
      fakeMessage(CHANNEL, { webhookId: '100000000000000600' }),
      fakeMessage(CHANNEL, { system: true }),
      fakeMessage(CHANNEL, { member: fakeMember(USER, { exempt: true }) }),
      fakeMessage(OTHER_CHANNEL),
      fakeMessage('100000000000000077'),
    );
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toEqual([]);
    expect(discord.calls).toEqual([]);
    expect(notifier.calls).toEqual([]);
    expect(errors()).toEqual([]);
  });
});

describe('deleted posts', () => {
  it('delete within grace resets the cooldown', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY, graceMs: 10 * 60 * 1000 });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    clock = at(5 * 60 * 1000).getTime();
    await deleteEvent(CHANNEL, message.id);
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toEqual([]);
    await say(fakeMessage(CHANNEL, { at: at(6 * 60 * 1000) }));
    expect(await postRows(t)).toHaveLength(1);
    expect(notifier.calls).toEqual([]);
  });

  it('delete after grace keeps the cooldown', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY, graceMs: 10 * 60 * 1000 });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    clock = at(10 * 60 * 1000).getTime();
    await deleteEvent(CHANNEL, message.id);
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: message.id })]);
  });

  it('delete without grace keeps the cooldown', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    await deleteEvent(CHANNEL, message.id);
    expect(await postRows(t)).toEqual([]);
    expect(await cooldownRows(t)).toHaveLength(1);
  });

  it('late delete of an older post does not reset the cooldown', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, keepLatest: false, graceMs: HOUR });
    await ready(ab!);
    const older = fakeMessage(CHANNEL, { at: at(0) });
    const newer = fakeMessage(CHANNEL, { at: at(60 * 1000) });
    await say(older);
    await say(newer);
    clock = at(2 * 60 * 1000).getTime();
    // Both are within grace, but the cooldown counts from the newer post.
    await deleteEvent(CHANNEL, older.id);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: newer.id })]);
    expect((await postRows(t)).map((row) => row.messageId)).toEqual([newer.id]);
  });

  it('a post deleted by the bot within grace keeps the cooldown', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY, graceMs: HOUR, deleteOnLeave: true });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    ab!.client.emit(Events.GuildMemberRemove, fakeMember());
    await ab!.bot.idle();
    clock = at(60 * 1000).getTime();
    await deleteEvent(CHANNEL, message.id);
    expect(await cooldownRows(t)).toEqual([expect.objectContaining({ messageId: message.id })]);
  });

  it('a delete event during the next post of its member does not deadlock', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, cooldownMs: DAY, graceMs: HOUR });
    await ready(ab!);
    const message = fakeMessage(CHANNEL, { at: at(0) });
    await say(message);
    clock = at(60 * 1000).getTime();

    // Holds the member's cooldown row, then deletes their posts, the lock order of accepting a post.
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const member = and(eq(cooldowns.channelId, CHANNEL), eq(cooldowns.userId, MEMBER));
    const accepting = autodeleteDb(t).run(async (tx) => {
      await tx.select().from(cooldowns).where(member).for('update');
      locked();
      await released;
      await tx.delete(posts).where(eq(posts.messageId, message.id));
    });
    await isLocked;
    ab!.client.emit(Events.MessageDelete, deletedMessage(CHANNEL, message.id));
    try {
      // Wait until the delete handler blocks on a lock held by the transaction above.
      for (let tries = 0; ; tries += 1) {
        const { rows } = await t.database.admin.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows.length > 0) break;
        if (tries > 2000) throw new Error('The delete handler never waited for the lock');
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      release();
    }
    await expect(accepting).resolves.toBeUndefined();
    await ab!.bot.idle();
    expect(errors()).toEqual([]);
  });

  it('bulk delete removes rows', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL, keepLatest: false, graceMs: HOUR });
    await ready(ab!);
    const first = fakeMessage(CHANNEL, { at: at(0) });
    const second = fakeMessage(CHANNEL, { at: at(1) });
    const other = fakeMessage(CHANNEL, { at: at(2), member: fakeMember(USER) });
    await say(first, second, other);
    const { messages, channel } = bulkDeleted(CHANNEL, [first.id, second.id]);
    ab!.client.emit(Events.MessageBulkDelete, messages, channel);
    await ab!.bot.idle();
    expect((await postRows(t)).map((row) => row.messageId)).toEqual([other.id]);
    expect((await cooldownRows(t)).map((row) => row.userId)).toEqual([USER]);
  });

  it('ignores deletes in channels without a rule', async () => {
    await start();
    await insertRule(t, { channelId: CHANNEL });
    await insertRule(t, { channelId: OTHER_CHANNEL });
    const messageId = snowflakeAt(at(0));
    await insertPost(t, { channelId: OTHER_CHANNEL, userId: MEMBER, messageId });
    await ready(ab!);
    await deleteEvent('100000000000000077', messageId);
    expect(await postRows(t)).toHaveLength(1);
    expect(errors()).toEqual([]);
  });
});
