import { fakeButton, FakeDiscordHttp, type FakeHttpAnswer, type FakeInteraction, type RecordedRequest } from '@bronto/core/testing';
import { ChannelType, Collection, Events, MessageFlags, MessageType, OverwriteType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeMessage, insertRule } from '../../mediaonly/test/harness.js';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import {
  addHistory,
  BOT_PERMISSIONS,
  FORUM,
  FORUM_POST,
  GUILD,
  MEMBER,
  MOD,
  OTHER,
  pressButton,
  prepareMoveBot,
  ready,
  runCommand,
  SOURCE,
  TARGET,
  THREAD,
  type MoveBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let mb: MoveBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await mb?.bot.stop();
  mb = undefined;
  await t.drop();
});

type Json = Record<string, any>;
const json = (value: unknown): Json => (typeof (value as Json).toJSON === 'function' ? (value as Json).toJSON() : (value as Json));
const answer = (fake: FakeInteraction): Json => json(fake.responses.at(-1)!.payload);
const result = (fake: FakeInteraction): string => String(answer(fake).content);
const buttons = (message: Json): Json[] => json(message).components.flatMap((row: unknown) => json(row).components.map(json));
const messageLink = (channelId: string, messageId: string) => `https://discord.com/channels/${GUILD}/${channelId}/${messageId}`;
const sentContents = () => discord.sent.map((sent) => sent.message.content);
const HOOK_USER = '100000000000000201';
const FOREIGN_HOOK = '100000000000000202';

/** Starts the bot; the forum grants the bot what it needs too, so its posts can be a source. */
async function start(options: { mediaonly?: boolean; beforeReady?: () => Promise<void> } = {}): Promise<MoveBot> {
  const grant = [{ id: discord.botId, type: OverwriteType.Member, allow: String(BOT_PERMISSIONS), deny: '0' }] as never;
  discord.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum, name: 'forum', permissionOverwrites: grant });
  mb = await prepareMoveBot(t, discord, { mediaonly: options.mediaonly });
  await options.beforeReady?.();
  await ready(mb);
  return mb;
}

/** Runs `/move` and returns the Move button's custom ID. */
async function confirmation(from: string, to: string | null, target: string, source = SOURCE, input: { attachmentSizeLimit?: number } = {}): Promise<string> {
  const options = { from: messageLink(source, from), ...(to === null ? {} : { to: messageLink(source, to) }), target: { id: target } };
  const fake = await runCommand(mb!, options, source, input);
  const move = buttons(answer(fake))[0];
  if (move === undefined) throw new Error(`No confirmation: ${result(fake)}`);
  return move.custom_id;
}

/** Runs `/move` and presses Move; returns the button's interaction. */
async function move(from: string, to: string | null, target = TARGET, source = SOURCE, input: { attachmentSizeLimit?: number } = {}): Promise<FakeInteraction> {
  return pressButton(mb!, await confirmation(from, to, target, source, input));
}

/** Lets requests to `method path` through to the fake, except the numbered calls `answers` answers itself. */
function intercept(method: string, path: string, answers: Record<number, ReturnType<FakeHttpAnswer> | ((pass: () => ReturnType<FakeHttpAnswer>) => ReturnType<FakeHttpAnswer>)>): void {
  let calls = 0;
  const pass = (request: RecordedRequest) => async () => {
    discord.clearOverride(method, path);
    try {
      return await discord.answer(request);
    } finally {
      discord.override(method, path, handler);
    }
  };
  const handler: FakeHttpAnswer = async (request: RecordedRequest) => {
    calls += 1;
    const answer = answers[calls];
    if (answer === undefined) return pass(request)();
    return typeof answer === 'function' ? answer(pass(request)) : answer;
  };
  discord.override(method, path, handler);
}

/** Answers the `n`th request to `method path` with `fail`; the others go to the fake as usual. */
function failAt(method: string, path: string, n: number, fail: ReturnType<FakeHttpAnswer>): void {
  intercept(method, path, { [n]: fail });
}

const MISSING_ACCESS = { status: 403, json: { code: 50001, message: 'Missing Access' } };
const INVALID_BODY = { status: 400, json: { code: 50035, message: 'Invalid Form Body' } };
/** Content long enough for two posts. */
const LONG = `${'word '.repeat(500)}\n${'more '.repeat(100)}`;
const twelveFiles = () => Array.from({ length: 12 }, (_, index) => ({ filename: `f${index}.txt`, data: 'x' }));

const deletes = (channelId: string) => mb!.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith(`/channels/${channelId}/messages/`));
const bulkDeletes = (channelId: string) => mb!.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${channelId}/messages/bulk-delete`);

describe('running a move', () => {
  it('moves a range and deletes the originals', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'a', authorId: MEMBER }, { content: 'b', authorId: OTHER }, { content: 'c', authorId: MEMBER }]);
    const pressed = await move(ids[0]!, ids[2]!);
    expect(sentContents()).toEqual(['a', 'b', 'c']);
    expect(discord.sent.every((sent) => sent.channelId === TARGET && sent.threadId === null)).toBe(true);
    expect(discord.liveMessages(SOURCE)).toEqual([]);
    expect(result(pressed)).toBe(`Moved **3** messages to <#${TARGET}>.`);
  });

  it("posts as the author's display name and avatar, silent, no mentions", async () => {
    await start();
    discord.members.get(`${GUILD}:${MEMBER}`)!.nick = 'Nick';
    discord.users.get(MEMBER)!.avatar = 'abcdef';
    discord.addUser(HOOK_USER, { bot: true, username: 'Hook Name' });
    const ids = addHistory(discord, SOURCE, [
      { content: `<@${MOD}> hello`, authorId: MEMBER },
      { content: 'from a hook', authorId: HOOK_USER, webhookId: FOREIGN_HOOK },
      { content: 'plain', authorId: OTHER },
    ]);
    await move(ids[0]!, ids[2]!);
    const [member, hook, other] = discord.sent;
    expect(member!.options.username).toBe('Nick');
    expect(member!.options.avatarUrl).toContain(`/avatars/${MEMBER}/abcdef`);
    expect(hook!.options.username).toBe('Hook Name');
    expect(other!.options.username).toBe('User 097');
    for (const sent of discord.sent) {
      expect(sent.options.flags).toBe(MessageFlags.SuppressNotifications);
      expect(sent.options.allowedMentions).toEqual({ parse: [] });
    }
    expect(member!.message.content).toBe(`<@${MOD}> hello`);
  });

  it('re-uploads attachments with names, spoilers and alt text', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [
      { content: 'look', authorId: MEMBER, files: [{ filename: 'SPOILER_cat.png', data: 'cat' }, { filename: 'dog.png', data: 'dogs' }] },
    ]);
    discord.messages.get(id!)!.attachments[1]!.description = 'A dog';
    await move(id!, null);
    expect(discord.sent[0]!.files).toEqual([
      { name: 'SPOILER_cat.png', size: 3 },
      { name: 'dog.png', description: 'A dog', size: 4 },
    ]);
    expect(discord.liveMessages(SOURCE)).toEqual([]);
  });

  it('adds reactions once, skips unknown custom emojis', async () => {
    await start();
    const known = '100000000000000300';
    (mb!.client.guilds.cache.get(GUILD)!.emojis as unknown as { _add(data: unknown): void })._add({ id: known, name: 'known' });
    // discord.js looks custom reaction emojis up among the application's emojis first; the test client has none.
    Object.assign(mb!.client.application!, { emojis: { cache: new Collection() } });
    const [id] = addHistory(discord, SOURCE, [
      {
        content: 'nice',
        reactions: [
          { emoji: { id: null, name: '👍' }, count: 3 },
          { emoji: { id: '100000000000000301', name: 'elsewhere' }, count: 1 },
          { emoji: { id: known, name: 'known' }, count: 2 },
        ],
      },
    ]);
    await move(id!, null);
    const repost = discord.sent[0]!.id;
    expect(discord.reactions).toEqual([
      { messageId: repost, emoji: '👍' },
      { messageId: repost, emoji: `known:${known}` },
    ]);
  });

  it('keeps and lists a message whose reaction fails to add; its copy keeps the reactions that worked', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    const refuse = { status: 403, json: { code: 50013, message: 'Missing Permissions' } };
    intercept('POST', `/webhooks/${hook.id}/${hook.token}`, {
      1: async (pass) => {
        const answer = await pass();
        const repost = (answer.json as { id: string }).id;
        discord.override('PUT', `/channels/${TARGET}/messages/${repost}/reactions/${encodeURIComponent('👍')}/@me`, () => refuse);
        return answer;
      },
    });
    const ids = addHistory(discord, SOURCE, [
      { content: 'liked', reactions: [{ emoji: { id: null, name: '👍' }, count: 1 }, { emoji: { id: null, name: '🎉' }, count: 1 }] },
      { content: 'plain' },
    ]);
    const text = result(await move(ids[0]!, ids[1]!));
    const [liked] = discord.sent;
    expect(sentContents()).toEqual(['liked', 'plain']);
    expect(discord.reactions).toEqual([{ messageId: liked!.id, emoji: '🎉' }]);
    expect(discord.liveMessages(SOURCE)).toEqual([ids[0]]);
    expect(discord.liveMessages(TARGET)).toContain(liked!.id);
    expect(text).toContain('Moved **1** message to');
    expect(text).toContain(`${messageLink(SOURCE, ids[0]!)} (reaction not added)`);
  });

  it('reply inside the range links to the repost; outside links to the original', async () => {
    await start();
    const [outside] = addHistory(discord, SOURCE, [{ content: 'said before the range', authorId: OTHER }]);
    const ids = addHistory(discord, SOURCE, [
      { content: 'first in range', authorId: MEMBER },
      { content: 'answer', authorId: OTHER },
      { content: 'late answer', authorId: MEMBER, referenceId: outside },
      { content: 'to nothing', authorId: MEMBER, referenceId: '100000000000000777' },
    ]);
    // The second message replies to the first one of the range.
    const reply = discord.messages.get(ids[1]!)! as unknown as Json;
    reply.type = MessageType.Reply;
    reply.message_reference = { type: 0, message_id: ids[0], channel_id: SOURCE, guild_id: GUILD };
    await move(ids[0]!, ids[3]!);
    const [first, answerPost, late, nothing] = discord.sent;
    expect(answerPost!.message.content).toBe(`-# ↪ [@User 098](<${messageLink(TARGET, first!.id)}>) first in range\nanswer`);
    expect(late!.message.content).toBe(`-# ↪ [@User 097](<${messageLink(SOURCE, outside!)}>) said before the range\nlate answer`);
    expect(nothing!.message.content).toBe('-# ↪ (deleted message)\nto nothing');
  });

  it('keeps too-large, poll, thread and forum-start messages and lists them', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [
      { content: 'plain' },
      { content: 'big', files: [{ filename: 'big.bin', data: 'x'.repeat(20) }] },
      { content: 'vote', poll: true },
      { content: 'threaded', threadId: '100000000000000400', flags: MessageFlags.HasThread },
    ]);
    const pressed = await move(ids[0]!, ids[3]!, TARGET, SOURCE, { attachmentSizeLimit: 10 });
    expect(sentContents()).toEqual([
      'plain',
      `big\n-# Attachment too large to move: [original](<${messageLink(SOURCE, ids[1]!)}>)`,
      `vote\n-# Poll not moved: [original](<${messageLink(SOURCE, ids[2]!)}>)`,
      `threaded\n-# Has a thread: [original](<${messageLink(SOURCE, ids[3]!)}>)`,
    ]);
    expect(discord.liveMessages(SOURCE)).toEqual(ids.slice(1));
    const text = result(pressed);
    expect(text).toContain('Moved **1** message to');
    expect(text).toContain(`${messageLink(SOURCE, ids[1]!)} (attachment too large)`);
    expect(text).toContain(`${messageLink(SOURCE, ids[2]!)} (poll)`);
    expect(text).toContain(`${messageLink(SOURCE, ids[3]!)} (has a thread)`);

    discord.addMessage(FORUM_POST, FORUM_POST, { content: 'opening', authorId: MEMBER });
    const [later] = addHistory(discord, FORUM_POST, [{ content: 'comment', authorId: OTHER }]);
    const forum = await move(FORUM_POST, later!, TARGET, FORUM_POST);
    expect(sentContents().slice(4)).toEqual([`opening\n-# Original post: [original](<${messageLink(FORUM_POST, FORUM_POST)}>)`, 'comment']);
    expect(discord.liveMessages(FORUM_POST)).toEqual([FORUM_POST]);
    expect(result(forum)).toContain(`${messageLink(FORUM_POST, FORUM_POST)} (original post)`);
  });

  it('a failed download keeps the message with the too-large notice', async () => {
    await start();
    // The fake CDN doesn't serve sticker images, so the download fails.
    const [id] = addHistory(discord, SOURCE, [{ content: 'hi', stickers: [{ id: '100000000000000310', name: 'wave', format: 1 }] }]);
    const pressed = await move(id!, null);
    expect(sentContents()).toEqual([`hi\n-# Sticker: wave\n-# Attachment too large to move: [original](<${messageLink(SOURCE, id!)}>)`]);
    expect(discord.sent[0]!.files).toEqual([]);
    expect(discord.liveMessages(SOURCE)).toEqual([id]);
    expect(result(pressed)).toContain(`${messageLink(SOURCE, id!)} (attachment too large)`);
  });

  it('puts files beyond ten on a further post', async () => {
    await start();
    const files = Array.from({ length: 10 }, (_, index) => ({ filename: `f${index}.txt`, data: 'x' }));
    const [id] = addHistory(discord, SOURCE, [
      { content: 'many', files, snapshots: [{ content: 'forwarded', files: [{ filename: 'g0.txt', data: 'y' }, { filename: 'g1.txt', data: 'y' }] }] },
    ]);
    await move(id!, null);
    expect(discord.sent.map((sent) => sent.files.length)).toEqual([10, 2]);
    expect(discord.sent[1]!.message.content).toBe('');
    expect(discord.liveMessages(SOURCE)).toEqual([]);
  });

  it('keeps a message with nothing to post and lists it', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: '', authorId: MEMBER }]);
    const pressed = await move(id!, null);
    expect(discord.sent).toEqual([]);
    expect(discord.liveMessages(SOURCE)).toEqual([id]);
    expect(result(pressed)).toContain(`couldn't be copied`);
    expect(result(pressed)).toContain(messageLink(SOURCE, id!));
  });

  it('deletes skipped system messages, keeps ThreadCreated', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'a' }, { type: MessageType.UserJoin }, { type: MessageType.ThreadCreated }, { content: 'b' }]);
    await move(ids[0]!, ids[3]!);
    expect(sentContents()).toEqual(['a', 'b']);
    expect(discord.liveMessages(SOURCE)).toEqual([ids[2]]);
  });

  it('bulk-deletes young and single-deletes old messages', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'o1', old: true }, { content: 'o2', old: true }, { content: 'y1' }, { content: 'y2' }, { content: 'y3' }]);
    await move(ids[0]!, ids[4]!);
    expect(bulkDeletes(SOURCE).map((r) => (r.body as { messages: string[] }).messages)).toEqual([ids.slice(2)]);
    expect(deletes(SOURCE).map((r) => r.path.split('/').at(-1))).toEqual(ids.slice(0, 2));
    expect(discord.liveMessages(SOURCE)).toEqual([]);

    const [lone] = addHistory(discord, SOURCE, [{ content: 'alone' }]);
    await move(lone!, null);
    expect(bulkDeletes(SOURCE)).toHaveLength(1);
    expect(deletes(SOURCE).map((r) => r.path.split('/').at(-1))).toEqual([...ids.slice(0, 2), lone]);
  });

  it('rolls back reposts when a send fails and deletes nothing', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    // Sends: a (1), the long message (2, 3), the twelve files (4 with ten files, 5 with two), c (6) fails.
    const ids = addHistory(discord, SOURCE, [{ content: 'a' }, { content: LONG }, { content: 'files', files: twelveFiles() }, { content: 'c' }]);
    failAt('POST', `/webhooks/${hook.id}/${hook.token}`, 6, MISSING_ACCESS);
    const pressed = await move(ids[0]!, ids[3]!);
    expect(discord.sent.map((sent) => sent.files.length)).toEqual([0, 0, 0, 10, 2]);
    expect(discord.deleted).toEqual(discord.sent.map((sent) => sent.id));
    expect(discord.botDeleted).toEqual([]);
    expect(discord.liveMessages(SOURCE)).toEqual(ids);
    expect(discord.liveMessages(TARGET)).toEqual([]);
    expect(result(pressed)).toContain('The move failed');
    expect(result(pressed)).toContain('Nothing was deleted');
  });

  it('a refused message stays without a copy; the rest moves, and a later failure still rolls back', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    // First move: a (1), long part 1 (2), long part 2 refused (3), b (4).
    // Second move: long part 1 (5), long part 2 refused (6), d (7), e fails (8).
    intercept('POST', `/webhooks/${hook.id}/${hook.token}`, { 3: INVALID_BODY, 6: INVALID_BODY, 8: MISSING_ACCESS });
    const first = addHistory(discord, SOURCE, [{ content: 'a' }, { content: LONG }, { content: 'b' }]);
    const pressed = await move(first[0]!, first[2]!);
    const [a, longPart, b] = discord.sent;
    expect([a, b].map((sent) => sent!.message.content)).toEqual(['a', 'b']);
    expect(discord.deleted).toEqual([longPart!.id]);
    expect(discord.liveMessages(SOURCE)).toEqual([first[1]]);
    expect(discord.liveMessages(TARGET)).toEqual([a!.id, b!.id]);
    expect(result(pressed)).toContain('Moved **2** messages');
    expect(result(pressed)).toContain(`couldn't be copied and stayed behind:\n- ${messageLink(SOURCE, first[1]!)}`);

    const second = addHistory(discord, SOURCE, [{ content: LONG }, { content: 'd' }, { content: 'e' }]);
    const failed = await move(second[0]!, second[2]!);
    expect(discord.deleted).toEqual(discord.sent.map((sent) => sent.id).filter((id) => id !== a!.id && id !== b!.id));
    expect(discord.liveMessages(TARGET)).toEqual([a!.id, b!.id]);
    expect(discord.liveMessages(SOURCE)).toEqual([first[1], ...second]);
    expect(result(failed)).toContain('The move failed');
  });

  it('says so when part of a refused copy stays', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    const refuseDelete = { status: 403, json: { code: 50013, message: 'Missing Permissions' } };
    intercept('POST', `/webhooks/${hook.id}/${hook.token}`, {
      1: async (pass) => {
        const answer = await pass();
        discord.override('DELETE', `/webhooks/${hook.id}/${hook.token}/messages/${(answer.json as { id: string }).id}`, () => refuseDelete);
        return answer;
      },
      2: INVALID_BODY,
    });
    const [id] = addHistory(discord, SOURCE, [{ content: LONG }]);
    const text = result(await move(id!, null));
    expect(text).toContain(`couldn't be copied fully and stayed behind; part of a copy is in the target:\n- ${messageLink(SOURCE, id!)}`);
    expect(text).not.toContain("couldn't be copied and stayed behind");
    expect(discord.liveMessages(SOURCE)).toEqual([id]);
  });

  it('ends the move on an error about the target, not the message', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    failAt('POST', `/webhooks/${hook.id}/${hook.token}`, 2, { status: 400, json: { code: 50083, message: 'Thread is archived' } });
    const ids = addHistory(discord, SOURCE, [{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
    const text = result(await move(ids[0]!, ids[2]!));
    expect(text).toContain('The move failed');
    expect(discord.deleted).toEqual([discord.sent[0]!.id]);
    expect(discord.sent).toHaveLength(1);
    expect(discord.liveMessages(SOURCE)).toEqual(ids);
  });

  it('reports originals it could not delete', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'stuck' }]);
    discord.override('DELETE', `/channels/${SOURCE}/messages/${id}`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    const pressed = await move(id!, null);
    expect(sentContents()).toEqual(['stuck']);
    expect(result(pressed)).toContain(`couldn't be deleted`);
    expect(result(pressed)).toContain(messageLink(SOURCE, id!));
  });

  it('lists a system message it could not delete without claiming a copy', async () => {
    await start();
    const [id, join] = addHistory(discord, SOURCE, [{ content: 'a' }, { type: MessageType.UserJoin }]);
    const refuse = () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } });
    discord.override('POST', `/channels/${SOURCE}/messages/bulk-delete`, refuse);
    discord.override('DELETE', `/channels/${SOURCE}/messages/${join}`, refuse);
    const text = result(await move(id!, join!));
    expect(discord.liveMessages(SOURCE)).toEqual([join]);
    expect(text).toContain(`Moved **1** message to`);
    expect(text).toContain(`**1** system message couldn't be deleted:\n- ${messageLink(SOURCE, join!)}`);
    expect(text).not.toContain('the copies are in the target');
  });

  it("reuses an existing Move webhook, ignores sticky's", async () => {
    await start();
    const others = [
      discord.addWebhook(TARGET, { name: 'Sticky' }),
      discord.addWebhook(TARGET, { name: 'Move', applicationId: null }),
      discord.addWebhook(TARGET, { name: 'Move', applicationId: '100000000000000555' }),
    ].map((hook) => hook.id);
    const [a, b] = addHistory(discord, SOURCE, [{ content: 'a' }, { content: 'b' }]);
    await move(a!, null);
    const created = mb!.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${TARGET}/webhooks`);
    expect(created.map((r) => (r.body as { name: string }).name)).toEqual(['Move']);
    const used = discord.sent[0]!.webhookId;
    expect(others).not.toContain(used);
    // Discord names the webhook as asked; the fake doesn't.
    discord.webhooks.get(used)!.name = 'Move';

    await move(b!, null);
    expect(mb!.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${TARGET}/webhooks`)).toHaveLength(1);
    expect(discord.sent[1]!.webhookId).toBe(used);
    expect(discord.deletedWebhooks).toEqual([]);
  });

  it('moves into a thread of another channel and from a thread into its parent', async () => {
    await start();
    const hook = discord.addWebhook(TARGET, { name: 'Move' });
    const [into] = addHistory(discord, SOURCE, [{ content: 'into the thread' }]);
    await move(into!, null, THREAD);
    expect(discord.sent[0]).toMatchObject({ channelId: TARGET, threadId: THREAD, message: { content: 'into the thread' } });
    expect(discord.liveMessages(THREAD)).toEqual([discord.sent[0]!.id]);

    const [out] = addHistory(discord, THREAD, [{ content: 'out of the thread' }]);
    await move(out!, null, TARGET, THREAD);
    expect(discord.sent[1]).toMatchObject({ channelId: TARGET, threadId: null, message: { content: 'out of the thread' } });
    expect(discord.liveMessages(THREAD)).toEqual([discord.sent[0]!.id]);
    expect(discord.sent.map((sent) => sent.webhookId)).toEqual([hook.id, hook.id]);
  });

  it('second overlapping move waits then runs', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'a1' }, { content: 'a2' }, { content: 'b1' }, { content: 'b2' }]);
    const first = await confirmation(ids[0]!, ids[1]!, TARGET);
    const second = await confirmation(ids[2]!, ids[3]!, THREAD);
    const presses = [first, second].map((customId) => fakeButton({ customId, guildId: GUILD, channelId: SOURCE, userId: MOD }));
    for (const press of presses) mb!.client.emit(Events.InteractionCreate, press);
    await mb!.bot.idle();
    const contents = sentContents();
    expect([contents.slice(0, 2), contents.slice(2)]).toContainEqual(['a1', 'a2']);
    expect([contents.slice(0, 2), contents.slice(2)]).toContainEqual(['b1', 'b2']);
    const shown = presses.map((press) => press.responses.map((response) => (response.payload as Json | undefined)?.content));
    expect(shown.filter((texts) => texts.includes('Waiting for another move…'))).toHaveLength(1);
    for (const press of presses) expect(result(press)).toContain('Moved **2** messages');
    expect(discord.liveMessages(SOURCE)).toEqual([]);
  });

  it('checks permissions again when Move is pressed', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const customId = await confirmation(id!, null, TARGET);
    // As a channel update from the gateway would: the bot lost its overwrite in the source.
    const source = mb!.client.channels.cache.get(SOURCE) as unknown as { permissionOverwrites: { cache: Map<string, unknown> } };
    source.permissionOverwrites.cache.delete(discord.botId);
    const before = mb!.requests.length;
    const text = result(await pressButton(mb!, customId));
    expect(text).toContain('Bot: Manage Messages in #general');
    expect(text).toContain('Nothing was moved.');
    expect(mb!.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(discord.sent).toEqual([]);
  });

  it('range partly deleted after confirming moves the rest; fully deleted changes nothing', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
    const partly = await confirmation(ids[0]!, ids[2]!, TARGET);
    discord.messages.delete(ids[0]!);
    discord.messages.delete(ids[2]!);
    expect(result(await pressButton(mb!, partly))).toContain('Moved **1** message to');
    expect(sentContents()).toEqual(['b']);

    const [gone] = addHistory(discord, SOURCE, [{ content: 'gone' }]);
    const fully = await confirmation(gone!, null, TARGET);
    discord.messages.delete(gone!);
    const before = mb!.requests.length;
    expect(result(await pressButton(mb!, fully))).toBe('Nothing left to move.');
    expect(mb!.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('mediaonly keeps text-only reposts in a target with ignore-bots off', async () => {
    await start({ mediaonly: true, beforeReady: async () => void (await insertRule(t, { channelId: TARGET, ignoreBots: false })) });
    const [id] = addHistory(discord, SOURCE, [{ content: 'just words' }]);
    await move(id!, null);
    const repost = discord.sent[0]!;
    const asGateway = (messageId: string, webhookId: string) => ({ ...fakeMessage(TARGET, { content: 'just words', member: null, bot: true, webhookId }), id: messageId });
    mb!.client.emit(Events.MessageCreate, asGateway(repost.id, repost.webhookId));
    await mb!.bot.idle();
    expect(discord.liveMessages(TARGET)).toContain(repost.id);

    const stranger = discord.newId();
    discord.addPost(TARGET, stranger, { content: 'just words', attachmentCount: 0 });
    mb!.client.emit(Events.MessageCreate, asGateway(stranger, FOREIGN_HOOK));
    await mb!.bot.idle();
    expect(discord.deletedPosts).toContain(stranger);
  });

  it('finishes and logs the result when the confirmation can no longer be edited', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'late' }]);
    const press = fakeButton({ customId: await confirmation(id!, null, TARGET), guildId: GUILD, channelId: SOURCE, userId: MOD });
    press.editReply = async () => {
      throw new Error('Unknown interaction');
    };
    mb!.client.emit(Events.InteractionCreate, press);
    await mb!.bot.idle();
    expect(sentContents()).toEqual(['late']);
    expect(discord.liveMessages(SOURCE)).toEqual([]);
    expect(mb!.lines).toContainEqual(expect.objectContaining({ level: 30, result: `Moved **1** message to <#${TARGET}>.` }));
  });

  it('logs the full lists when the result is cut short', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, Array.from({ length: 30 }, () => ({ content: 'vote', poll: true })));
    const text = result(await move(ids[0]!, ids.at(-1)!));
    expect(text).toContain('…and');
    expect(text.length).toBeLessThanOrEqual(2000);
    const logged = mb!.lines.find((line) => (line as { lists?: unknown }).lists !== undefined) as unknown as { level: number; lists: { stayed: string[] } };
    expect(logged.level).toBe(30);
    expect(logged.lists.stayed).toEqual(ids.map((id) => `${messageLink(SOURCE, id)} (poll)`));
  });

  it('never deletes the source thread', async () => {
    await start();
    const ids = addHistory(discord, THREAD, [{ content: 'a' }, { content: 'b' }]);
    await move(ids[0]!, ids[1]!, TARGET, THREAD);
    expect(discord.liveMessages(THREAD)).toEqual([]);
    expect(discord.channels.has(THREAD)).toBe(true);
    expect(mb!.requests.filter((r) => r.path === `/channels/${THREAD}` && r.method !== 'GET')).toEqual([]);
  });
});
