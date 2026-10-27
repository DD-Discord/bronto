import { createBot, createScopedDb, moduleRoleName, upsertGuild, type Bot, type LoadedModule, type ScopedDb } from '@bronto/core';
import {
  captureLog,
  createNativeTestClient,
  fakeCommand,
  TEST_INTERACTION_SECRET,
  type FakeDiscordHttp,
  type FakeInteraction,
  type LogLine,
  type NativeTestClient,
  type RecordedRequest,
} from '@bronto/core/testing';
import { createStickyModule, stickyConfigSchema } from '@bronto/sticky';
import { createTemplatesModule } from '@bronto/templates';
import { ChannelType, Collection, Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { mediaonlyConfigSchema, type MediaonlyConfig } from '../src/config.js';
import { rules, type Rule } from '../src/db/schema.js';
import { createMediaonlyModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const CHANNEL = '100000000000000010';
export const OTHER_CHANNEL = '100000000000000011';
export const LOG_CHANNEL = '100000000000000012';
export const LOG_THREAD = '100000000000000013';
export const THREAD = '100000000000000014';
export const FORUM = '100000000000000015';
export const USER = '100000000000000099';
export const MEMBER = '100000000000000098';

export function mediaonlyModule(config: Partial<MediaonlyConfig> = {}): LoadedModule {
  return { packageName: '@bronto/mediaonly', definition: createMediaonlyModule(), config: mediaonlyConfigSchema.parse(config) };
}

export interface MediaonlyBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Database access as the mediaonly module, the way its handlers get it. */
export function mediaonlyDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'mediaonly'));
}

/** Sticky (with templates, which it needs) loads only with `sticky: true`. */
function modulesFor(sticky: boolean, config: Partial<MediaonlyConfig>): LoadedModule[] {
  const stickyModules: LoadedModule[] = sticky
    ? [
        { packageName: '@bronto/templates', definition: createTemplatesModule(), config: {} },
        { packageName: '@bronto/sticky', definition: createStickyModule(), config: stickyConfigSchema.parse({}) },
      ]
    : [];
  return [...stickyModules, mediaonlyModule(config)];
}

/** A bot with the mediaonly module: database migrated and GUILD (a community server) registered, not yet ready. */
export async function prepareMediaonlyBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { config?: Partial<MediaonlyConfig>; sticky?: boolean; extra?: LoadedModule[] } = {},
): Promise<MediaonlyBot> {
  discord.addGuild(GUILD, { community: true });
  for (const id of [CHANNEL, OTHER_CHANNEL, LOG_CHANNEL]) {
    if (!discord.channels.has(id)) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  }
  if (!discord.channels.has(LOG_THREAD)) discord.addChannel(LOG_THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: LOG_CHANNEL });
  if (!discord.channels.has(THREAD)) discord.addChannel(THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: CHANNEL });
  if (!discord.channels.has(FORUM)) discord.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
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
    modules: [...modulesFor(options.sticky ?? false, options.config ?? {}), ...(options.extra ?? [])],
    database: t.database,
    client,
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines, requests, native, http: discord };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, native }: MediaonlyBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs a slash command in GUILD as USER and waits for its work. */
export async function runCommand(
  mb: MediaonlyBot,
  command: string,
  subcommand: string,
  options: Record<string, unknown> = {},
  channelId = CHANNEL,
): Promise<FakeInteraction> {
  const fake = fakeCommand({ command, subcommand, guildId: GUILD, channelId, userId: USER, options });
  mb.client.emit(Events.InteractionCreate, fake);
  await mb.bot.idle();
  return fake;
}

/** A channel option value as discord.js resolves it. */
export const channelOption = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

export async function insertRule(
  t: TestDatabase,
  values: Partial<typeof rules.$inferInsert> & { channelId: string },
  guildId = GUILD,
): Promise<Rule> {
  const rows = await mediaonlyDb(t, guildId).run(async (tx) => tx.insert(rules).values(values).returning());
  return rows[0]!;
}

export const ruleRows = (t: TestDatabase): Promise<Rule[]> => t.database.admin.select().from(rules).orderBy(rules.channelId);

export interface FakeMemberOptions {
  /** Manage Messages in every channel. */
  exempt?: boolean;
}

/** A guild member as a gateway message carries it. */
export function fakeMember(userId = MEMBER, options: FakeMemberOptions = {}) {
  return {
    id: userId,
    displayName: `User ${userId.slice(-3)}`,
    displayAvatarURL: () => `https://cdn.example.test/members/${userId}.png`,
    permissionsIn: () => ({ has: () => options.exempt ?? false }),
  };
}

export interface FakeMessageOptions {
  content?: string;
  /** One entry per attachment: whether it is marked spoiler. */
  attachments?: boolean[];
  member?: ReturnType<typeof fakeMember> | null;
  bot?: boolean;
  webhookId?: string | null;
  system?: boolean;
}

let nextId = 100000000000700000n;

/** A gateway message in GUILD with only the parts the module reads. */
export function fakeMessage(channelId: string, options: FakeMessageOptions = {}) {
  const member = options.member === undefined ? fakeMember() : options.member;
  const id = String(nextId++);
  const authorId = member?.id ?? USER;
  const attachments = new Collection(
    (options.attachments ?? []).map((spoiler, index) => {
      const attachmentId = `${id}${index}`;
      return [attachmentId, { id: attachmentId, name: spoiler ? `SPOILER_photo${index}.png` : `photo${index}.png`, spoiler }] as const;
    }),
  );
  return {
    id,
    channelId,
    guildId: GUILD,
    content: options.content ?? 'Hello there',
    attachments,
    webhookId: options.webhookId ?? null,
    system: options.system ?? false,
    author: {
      id: authorId,
      bot: options.bot ?? false,
      username: `user${authorId.slice(-3)}`,
      displayName: `Author ${authorId.slice(-3)}`,
      displayAvatarURL: () => `https://cdn.example.test/avatars/${authorId}.png`,
    },
    member,
  };
}
