import { createBot, upsertGuild, type Bot, type LoadedModule } from '@bronto/core';
import {
  captureLog,
  createNativeTestClient,
  fakeButton,
  fakeCommand,
  TEST_INTERACTION_SECRET,
  type FakeDiscordHttp,
  type FakeInteraction,
  type LogLine,
  type NativeTestClient,
  type RecordedRequest,
} from '@bronto/core/testing';
import { createMediaonlyModule, mediaonlyConfigSchema } from '@bronto/mediaonly';
import { createStickyModule, stickyConfigSchema } from '@bronto/sticky';
import { createTemplatesModule } from '@bronto/templates';
import { ChannelType, Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { createMoveModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const SOURCE = '100000000000000010';
export const TARGET = '100000000000000011';
export const THREAD = '100000000000000014';
export const FORUM = '100000000000000015';
export const FORUM_POST = '100000000000000016';
export const MOD = '100000000000000099';
export const MEMBER = '100000000000000098';
export const OTHER = '100000000000000097';

export interface MoveBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Sticky (with templates, which it needs) and mediaonly load only when asked for. */
function modulesFor(options: { sticky?: boolean; mediaonly?: boolean; extra?: LoadedModule[] }): LoadedModule[] {
  const modules: LoadedModule[] = [];
  if (options.sticky === true) {
    modules.push(
      { packageName: '@bronto/templates', definition: createTemplatesModule(), config: {} },
      { packageName: '@bronto/sticky', definition: createStickyModule(), config: stickyConfigSchema.parse({}) },
    );
  }
  if (options.mediaonly === true) {
    modules.push({ packageName: '@bronto/mediaonly', definition: createMediaonlyModule(), config: mediaonlyConfigSchema.parse({}) });
  }
  return [...modules, { packageName: '@bronto/move', definition: createMoveModule(), config: {} }, ...(options.extra ?? [])];
}

/** Adds GUILD with its channels, a thread of TARGET, a forum with one post and three members, without a bot yet. */
export function addMoveFixtures(discord: FakeDiscordHttp): void {
  discord.addGuild(GUILD, { community: true });
  for (const id of [SOURCE, TARGET]) {
    if (!discord.channels.has(id)) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  }
  if (!discord.channels.has(THREAD)) discord.addChannel(THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: TARGET });
  if (!discord.channels.has(FORUM)) discord.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  if (!discord.channels.has(FORUM_POST)) discord.addChannel(FORUM_POST, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM });
  for (const id of [MOD, MEMBER, OTHER]) discord.addMember(GUILD, id);
}

/** A bot with the move module: GUILD registered, not yet ready. */
export async function prepareMoveBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { sticky?: boolean; mediaonly?: boolean; extra?: LoadedModule[] } = {},
): Promise<MoveBot> {
  addMoveFixtures(discord);
  const native = await createNativeTestClient(discord);
  const { client, requests } = native;
  const { log, lines } = captureLog();
  const bot = createBot({
    config: {
      discord: { token: 'token' },
      database: { appUrl: t.appUrl, adminUrl: t.adminUrl },
      modules: {},
      interactions: { secret: TEST_INTERACTION_SECRET },
    },
    modules: modulesFor(options),
    database: t.database,
    client,
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines, requests, native, http: discord };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, native }: MoveBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs `/move` in GUILD as MOD and waits for its work. */
export async function runCommand(
  mb: MoveBot,
  options: Record<string, unknown> = {},
  channelId = SOURCE,
  input: { userId?: string; permissions?: bigint; attachmentSizeLimit?: number } = {},
): Promise<FakeInteraction> {
  const fake = fakeCommand({ command: 'move', guildId: GUILD, channelId, userId: MOD, options, ...input });
  mb.client.emit(Events.InteractionCreate, fake);
  await mb.bot.idle();
  return fake;
}

/** Presses a button in GUILD as MOD and waits for its work. */
export async function pressButton(
  mb: MoveBot,
  customId: string,
  input: { userId?: string; channelId?: string } = {},
): Promise<FakeInteraction> {
  const fake = fakeButton({ customId, guildId: GUILD, channelId: SOURCE, userId: MOD, ...input });
  mb.client.emit(Events.InteractionCreate, fake);
  await mb.bot.idle();
  return fake;
}

export interface HistorySpec {
  content?: string;
  authorId?: string;
  webhookId?: string | null;
  /** Dates the message 30 days back, past bulk deletion's 14-day limit. */
  old?: boolean;
  [option: string]: unknown;
}

const DISCORD_EPOCH = 1420070400000;
let sequence = 0n;
let lastFresh = 0;
let lastOld = 0;

/** A snowflake for the given time (ms) with a unique sequence part. */
function snowflake(time: number): string {
  return String((BigInt(time - DISCORD_EPOCH) << 22n) + (sequence++ % 4096n));
}

/**
 * Adds messages to a channel and returns their IDs. Fresh messages get strictly increasing snowflakes dated about a
 * minute ago, across calls too. `old` messages are dated 30 days back on a clock of their own, so they sort below
 * every fresh one; within a call they must therefore come before the fresh ones (a fresh spec followed by an old one
 * throws). Other fields go to `addMessage`.
 */
export function addHistory(discord: FakeDiscordHttp, channelId: string, specs: HistorySpec[]): string[] {
  const now = Date.now();
  const ids: string[] = [];
  let sawFresh = false;
  for (const spec of specs) {
    const { old, ...options } = spec;
    if (old === true && sawFresh) throw new Error('addHistory: old messages must come before fresh ones');
    let time: number;
    if (old === true) time = lastOld = Math.max(now - 30 * 86_400_000, lastOld + 1);
    else {
      sawFresh = true;
      time = lastFresh = Math.max(now - 60_000, lastFresh + 1);
    }
    const id = snowflake(time);
    discord.addMessage(channelId, id, { ...options, timestamp: new Date(time).toISOString() } as never);
    ids.push(id);
  }
  return ids;
}
