import {
  createBot,
  createScopedDb,
  moduleRoleName,
  upsertGuild,
  type Bot,
  type LoadedModule,
  type ScopedDb,
} from '@bronto/core';
import {
  captureLog,
  createNativeTestClient,
  type FakeDiscordHttp,
  type LogLine,
  type NativeTestClient,
  type RecordedRequest,
} from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { createTemplatesModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const FORUM = '100000000000000010';
export const USER = '100000000000000099';

export function templatesModule(): LoadedModule {
  return { packageName: '@bronto/templates', definition: createTemplatesModule(), config: {} };
}

export interface TemplatesBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Database access as the templates module, the way its handlers get it. */
export function templatesDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'templates'));
}

/** A bot with the templates module: database migrated and GUILD (a community server with a forum) registered, not yet ready. */
export async function prepareTemplatesBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { extra?: LoadedModule[] } = {},
): Promise<TemplatesBot> {
  discord.addGuild(GUILD, { community: true });
  if (!discord.channels.has(FORUM)) discord.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  const native = await createNativeTestClient(discord);
  const { client, requests } = native;
  const { log, lines } = captureLog();
  const bot = createBot({
    config: { discord: { token: 'token' }, database: { appUrl: t.appUrl, adminUrl: t.adminUrl }, modules: {}, interactions: {} },
    modules: [templatesModule(), ...(options.extra ?? [])],
    database: t.database,
    client,
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines, requests, native, http: discord };
}
