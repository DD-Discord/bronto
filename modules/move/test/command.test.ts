import { FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { CONFIRM_MS } from '../src/limits.js';
import { PendingMoves } from '../src/pending.js';
import { addHistory, BOT_PERMISSIONS, GUILD, MEMBER, pressButton, prepareMoveBot, ready, runCommand, SOURCE, TARGET, THREAD, type MoveBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let mb: MoveBot | undefined;

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

type Json = Record<string, any>;
const json = (value: unknown): Json => (typeof (value as Json).toJSON === 'function' ? (value as Json).toJSON() : (value as Json));
const answer = (fake: FakeInteraction, index = fake.responses.length - 1): Json => json(fake.responses[index]!.payload);
const buttons = (message: Json): Json[] => json(message).components.flatMap((row: unknown) => json(row).components.map(json));
const messageLink = (channelId: string, messageId: string, guildId = GUILD) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/** Starts the bot holding `permissions` in the source and target channels. */
async function start(permissions: bigint = BOT_PERMISSIONS): Promise<MoveBot> {
  mb = await prepareMoveBot(t, discord, { botPermissions: permissions });
  await ready(mb);
  return mb;
}

const targetOption = (id: string) => ({ id });

describe('/move', () => {
  it('shows the confirmation with links and counts', async () => {
    const bot = await start();
    const ids = addHistory(discord, SOURCE, [{ content: 'a' }, { content: 'b' }, { content: 'poll', poll: true }, { content: 'c' }]);
    const fake = await runCommand(bot, { from: messageLink(SOURCE, ids[0]!), to: messageLink(SOURCE, ids[3]!), target: targetOption(TARGET) });
    const message = answer(fake);
    expect(message.content).toContain(`<#${SOURCE}>`);
    expect(message.content).toContain(`<#${TARGET}>`);
    expect(message.content).toContain(`First: ${messageLink(SOURCE, ids[0]!)}`);
    expect(message.content).toContain(`Last: ${messageLink(SOURCE, ids[3]!)}`);
    expect(message.content).toContain('**3** messages will move.');
    expect(message.content).toContain('1 stay behind: 1 polls.');
    expect(buttons(message).map((b) => b.label)).toEqual(['Move', 'Cancel']);
  });

  it('one link for a single message', async () => {
    const bot = await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const message = answer(await runCommand(bot, { from: messageLink(SOURCE, id!), target: targetOption(THREAD) }));
    expect(message.content).toContain(`Message: ${messageLink(SOURCE, id!)}`);
    expect(message.content).not.toContain('Last:');
    expect(message.content).toContain('**1** message will move.');
  });

  const refusal = async (options: Record<string, unknown>, input: Parameters<typeof runCommand>[3] = {}): Promise<string> =>
    String(answer(await runCommand(mb!, options, SOURCE, input)).content);

  it('refuses links from another server', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    expect(await refusal({ from: messageLink(SOURCE, id!, '100000000000000555'), target: targetOption(TARGET) })).toContain('another server');
  });

  it('refuses links from two channels', async () => {
    await start();
    const [a] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const [b] = addHistory(discord, TARGET, [{ content: 'b' }]);
    expect(await refusal({ from: messageLink(SOURCE, a!), to: messageLink(TARGET, b!), target: targetOption(THREAD) })).toContain('same channel');
  });

  it('refuses the source as target', async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    expect(await refusal({ from: messageLink(SOURCE, id!), target: targetOption(SOURCE) })).toContain('already in that channel');
  });

  it('refuses text that is not a link', async () => {
    await start();
    expect(await refusal({ from: 'nope', target: targetOption(TARGET) })).toContain('isn\'t a link');
  });

  it("names the moderator's missing permissions", async () => {
    await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const text = await refusal({ from: messageLink(SOURCE, id!), target: targetOption(TARGET) }, { userId: MEMBER });
    expect(text).toContain('You: Manage Messages in #general');
    expect(text).not.toContain('Bot:');
  });

  it("names the bot's missing permissions", async () => {
    await start(BOT_PERMISSIONS & ~PermissionFlagsBits.ManageWebhooks);
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const text = await refusal({ from: messageLink(SOURCE, id!), target: targetOption(TARGET) });
    expect(text).toContain('Bot: Manage Webhooks in #games');
    expect(text).not.toContain('You:');
  });

  it('names the parent for Manage Webhooks when the target is a thread', async () => {
    await start(BOT_PERMISSIONS & ~PermissionFlagsBits.ManageWebhooks);
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const text = await refusal({ from: messageLink(SOURCE, id!), target: targetOption(THREAD) });
    expect(text).toContain('Bot: Manage Webhooks in #games');
    expect(text).not.toContain('#games-thread');
  });

  it('refuses ranges over the cap', async () => {
    await start();
    const ids = addHistory(discord, SOURCE, Array.from({ length: 201 }, () => ({ content: 'x' })));
    const [first, last] = [ids[0]!, ids.at(-1)!];
    expect(await refusal({ from: messageLink(SOURCE, first), to: messageLink(SOURCE, last), target: targetOption(TARGET) })).toContain('at most 200');
  });
});

describe('confirmation buttons', () => {
  async function confirmation(): Promise<{ move: string; cancel: string }> {
    const bot = await start();
    const [id] = addHistory(discord, SOURCE, [{ content: 'a' }]);
    const [move, cancel] = buttons(answer(await runCommand(bot, { from: messageLink(SOURCE, id!), target: targetOption(TARGET) })));
    return { move: move!.custom_id, cancel: cancel!.custom_id };
  }

  it('moving answers "Moving…" without buttons', async () => {
    const { move } = await confirmation();
    const pressed = await pressButton(mb!, move);
    expect(answer(pressed, 0).content).toBe('Moving…');
    expect(answer(pressed, 0).components).toEqual([]);
  });

  it('cancel ends without changes', async () => {
    const { cancel, move } = await confirmation();
    const requestsBefore = mb!.requests.length;
    const pressed = await pressButton(mb!, cancel);
    expect(answer(pressed).content).toBe('Move cancelled.');
    expect(answer(pressed).components).toEqual([]);
    expect(mb!.requests.slice(requestsBefore).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(answer(await pressButton(mb!, move)).content).toContain('expired');
  });

  it('an expired confirmation says so and changes nothing', async () => {
    const { move } = await confirmation();
    await pressButton(mb!, move);
    const requestsBefore = mb!.requests.length;
    const again = await pressButton(mb!, move);
    expect(answer(again).content).toContain('expired');
    expect(mb!.requests.slice(requestsBefore).filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it("another user's press is refused", async () => {
    const { move } = await confirmation();
    const requestsBefore = mb!.requests.length;
    const pressed = await pressButton(mb!, move, { userId: MEMBER });
    expect(answer(pressed).content).not.toBe('Moving…');
    expect(mb!.requests.slice(requestsBefore).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(answer(await pressButton(mb!, move), 0).content).toBe('Moving…');
  });
});

describe('PendingMoves', () => {
  const move = (createdAt: number) => ({ guildId: 'g', userId: 'u', sourceId: 's', targetId: 't', fromId: '1', toId: null, uploadLimit: 1, createdAt });

  it('hands out 12 URL-safe characters and each move once', () => {
    const pending = new PendingMoves();
    const token = pending.create(move(Date.now()));
    expect(token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(pending.take(token)).not.toBeNull();
    expect(pending.take(token)).toBeNull();
  });

  it('treats old moves as missing and clears by server', () => {
    vi.useFakeTimers();
    const pending = new PendingMoves();
    const old = pending.create(move(Date.now()));
    vi.advanceTimersByTime(CONFIRM_MS + 1);
    expect(pending.take(old)).toBeNull();
    const kept = pending.create(move(Date.now()));
    pending.clear('g');
    expect(pending.take(kept)).toBeNull();
  });
});
