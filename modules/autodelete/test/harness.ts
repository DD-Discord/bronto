import { createBot, createScopedDb, moduleRoleName, upsertGuild, type Bot, type LoadedModule, type ScopedDb } from '@bronto/core';
import { captureLog, FakeClient, type LogLine } from '@bronto/core/testing';
import { Collection, Events, SnowflakeUtil } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { autodeleteConfigSchema, type AutodeleteConfig } from '../src/config.js';
import { cooldowns, posts, rules, type Rule } from '../src/db/schema.js';
import { createAutodeleteModule, type AutodeleteModuleOptions } from '../src/index.js';
import type { RuleIndex } from '../src/rule-index.js';
import type { MemberInfo, Notifier, Removal } from '../src/tracker.js';
import type { FakeAutodeleteDiscord } from './fake-discord.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const CHANNEL = '100000000000000010';
export const OTHER_CHANNEL = '100000000000000011';
export const LOG_CHANNEL = '100000000000000012';
export const LOG_THREAD = '100000000000000013';
export const USER = '100000000000000099';
export const MEMBER = '100000000000000098';

export function autodeleteModule(
  discord?: FakeAutodeleteDiscord,
  config: Partial<AutodeleteConfig> = {},
  index?: RuleIndex,
  options: Pick<AutodeleteModuleOptions, 'notifier' | 'now'> = {},
): LoadedModule {
  return {
    packageName: '@bronto/autodelete',
    definition: createAutodeleteModule({ ...(discord === undefined ? {} : { discord: () => discord }), index, ...options }),
    config: autodeleteConfigSchema.parse(config),
  };
}

export interface AutodeleteBot {
  bot: Bot;
  client: FakeClient;
  lines: LogLine[];
}

/** Database access as the autodelete module, the way its handlers get it. */
export function autodeleteDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'autodelete'));
}

/** A bot with the autodelete module: database migrated and GUILD registered, not yet ready. */
export async function prepareAutodeleteBot(
  t: TestDatabase,
  discord: FakeAutodeleteDiscord,
  options: { config?: Partial<AutodeleteConfig>; index?: RuleIndex } & Pick<AutodeleteModuleOptions, 'notifier' | 'now'> = {},
): Promise<AutodeleteBot> {
  const client = new FakeClient();
  client.guilds.cache.set(GUILD, { id: GUILD, available: true });
  const { log, lines } = captureLog();
  const bot = createBot({
    config: { discord: { token: 'token' }, database: { appUrl: t.appUrl, adminUrl: t.adminUrl }, modules: {}, interactions: {} },
    modules: [autodeleteModule(discord, options.config, options.index, { notifier: options.notifier, now: options.now })],
    database: t.database,
    client: client.asClient(),
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, client }: AutodeleteBot): Promise<void> {
  await bot.start();
  client.emit(Events.ClientReady, client);
  await bot.idle();
}

export async function insertRule(
  t: TestDatabase,
  values: Partial<typeof rules.$inferInsert> & { channelId: string },
  guildId = GUILD,
): Promise<Rule> {
  const rows = await autodeleteDb(t, guildId).run(async (tx) => tx.insert(rules).values(values).returning());
  return rows[0]!;
}

export async function insertCooldown(
  t: TestDatabase,
  values: { channelId: string; userId: string; messageId?: string; postedAt?: Date },
): Promise<void> {
  await autodeleteDb(t).run(async (tx) => {
    await tx.insert(cooldowns).values({ messageId: '100000000000000500', postedAt: new Date('2026-01-01T00:00:00Z'), ...values });
  });
}

export async function insertPost(
  t: TestDatabase,
  values: { channelId: string; userId: string; messageId: string; postedAt?: Date },
): Promise<void> {
  await autodeleteDb(t).run(async (tx) => {
    await tx.insert(posts).values({ postedAt: new Date('2026-01-01T00:00:00Z'), ...values });
  });
}

export const ruleRows = (t: TestDatabase): Promise<Rule[]> => t.database.admin.select().from(rules).orderBy(rules.channelId);
export const cooldownRows = (t: TestDatabase) => t.database.admin.select().from(cooldowns).orderBy(cooldowns.channelId, cooldowns.userId);
export const postRows = (t: TestDatabase) => t.database.admin.select().from(posts).orderBy(posts.messageId);

/** Every notifier call, in order, with the context left out. */
export type NotifierCall =
  | { kind: 'replaced'; channelId: string; member: MemberInfo; removed: Removal; newPost: { messageId: string; content: string } }
  | {
      kind: 'rejected';
      channelId: string;
      member: MemberInfo;
      rejected: Removal;
      current: { messageId: string; post: { content: string; attachmentCount: number } | null } | null;
      nextPostAt: Date;
    }
  | { kind: 'left'; channelId: string; member: MemberInfo; removed: Removal };

export class RecordingNotifier implements Notifier {
  readonly calls: NotifierCall[] = [];

  async replaced(...[, rule, member, removed, newPost]: Parameters<Notifier['replaced']>): Promise<void> {
    this.calls.push({ kind: 'replaced', channelId: rule.channelId, member, removed, newPost });
  }

  async rejected(...[, rule, member, rejected, current, nextPostAt]: Parameters<Notifier['rejected']>): Promise<void> {
    this.calls.push({ kind: 'rejected', channelId: rule.channelId, member, rejected, current, nextPostAt });
  }

  async left(...[, rule, member, removed]: Parameters<Notifier['left']>): Promise<void> {
    this.calls.push({ kind: 'left', channelId: rule.channelId, member, removed });
  }
}

/** A message ID whose snowflake carries `at`; `increment` tells apart messages of the same millisecond. */
export function snowflakeAt(at: Date, increment = 0): string {
  return SnowflakeUtil.generate({ timestamp: at.getTime(), increment: BigInt(increment) }).toString();
}

export interface FakeMemberOptions {
  /** Manage Messages in every channel. */
  exempt?: boolean;
  nickname?: string | null;
  joinedAt?: Date | null;
}

/** A guild member as the tracker sees it. */
export function fakeMember(userId = MEMBER, options: FakeMemberOptions = {}) {
  const user = {
    id: userId,
    bot: false,
    username: `user${userId.slice(-3)}`,
    displayName: `User ${userId.slice(-3)}`,
    displayAvatarURL: () => `https://cdn.example.test/avatars/${userId}.png`,
  };
  return {
    id: userId,
    guild: { id: GUILD },
    user,
    displayName: options.nickname ?? user.displayName,
    joinedAt: options.joinedAt === undefined ? new Date('2025-06-01T00:00:00Z') : options.joinedAt,
    displayAvatarURL: () => `https://cdn.example.test/members/${userId}.png`,
    permissionsIn: () => ({ has: () => options.exempt ?? false }),
  };
}

export interface FakeMessageOptions {
  id?: string;
  /** The message time, encoded in its ID. */
  at?: Date;
  content?: string;
  member?: ReturnType<typeof fakeMember> | null;
  bot?: boolean;
  webhookId?: string | null;
  system?: boolean;
}

let increments = 0;

/** A gateway message in GUILD as the tracker sees it. */
export function fakeMessage(channelId: string, options: FakeMessageOptions = {}) {
  const member = options.member === undefined ? fakeMember() : options.member;
  increments = (increments + 1) % 4096;
  return {
    id: options.id ?? snowflakeAt(options.at ?? new Date('2026-03-01T12:00:00Z'), increments),
    channelId,
    guildId: GUILD,
    content: options.content ?? 'Hello there',
    webhookId: options.webhookId ?? null,
    system: options.system ?? false,
    author: { id: member?.id ?? USER, bot: options.bot ?? false },
    member,
  };
}

/** A deleted message as discord.js reports it: possibly partial, so only IDs. */
export function deletedMessage(channelId: string, messageId: string) {
  return { id: messageId, channelId, guildId: GUILD, partial: true };
}

export function bulkDeleted(channelId: string, messageIds: string[]) {
  const messages = new Collection(messageIds.map((id) => [id, deletedMessage(channelId, id)] as const));
  return { messages, channel: { id: channelId, guildId: GUILD } };
}
