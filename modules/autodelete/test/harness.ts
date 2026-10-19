import { createBot, createScopedDb, moduleRoleName, upsertGuild, type Bot, type LoadedModule, type ScopedDb } from '@bronto/core';
import { captureLog, FakeClient, type LogLine } from '@bronto/core/testing';
import { Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { autodeleteConfigSchema, type AutodeleteConfig } from '../src/config.js';
import { cooldowns, posts, rules, type Rule } from '../src/db/schema.js';
import { createAutodeleteModule } from '../src/index.js';
import type { RuleIndex } from '../src/rule-index.js';
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
): LoadedModule {
  return {
    packageName: '@bronto/autodelete',
    definition: createAutodeleteModule({ ...(discord === undefined ? {} : { discord: () => discord }), index }),
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
  options: { config?: Partial<AutodeleteConfig>; index?: RuleIndex } = {},
): Promise<AutodeleteBot> {
  const client = new FakeClient();
  client.guilds.cache.set(GUILD, { id: GUILD, available: true });
  const { log, lines } = captureLog();
  const bot = createBot({
    config: { discord: { token: 'token' }, database: { appUrl: t.appUrl, adminUrl: t.adminUrl }, modules: {}, interactions: {} },
    modules: [autodeleteModule(discord, options.config, options.index)],
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
