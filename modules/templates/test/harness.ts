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
  TEST_INTERACTION_SECRET,
} from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import type { TemplatesContext } from '../src/context.js';
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

/**
 * A bot with the templates module: database migrated and GUILD (a community server unless `community` is false, with
 * a forum) registered, not yet ready.
 */
export async function prepareTemplatesBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { extra?: LoadedModule[]; community?: boolean } = {},
): Promise<TemplatesBot> {
  discord.addGuild(GUILD, { community: options.community ?? true });
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
    modules: [templatesModule(), ...(options.extra ?? [])],
    database: t.database,
    client,
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines, requests, native, http: discord };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, native }: TemplatesBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs `fn` as a templates handler of GUILD and returns its result. */
export async function inHandler<T>(tb: TemplatesBot, fn: (ctx: TemplatesContext) => Promise<T>): Promise<T> {
  const runtime = tb.bot.runtimes.find((entry) => entry.name === 'templates')!;
  let result: { value: T } | undefined;
  const outcome = await tb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
    result = { value: await fn(ctx as TemplatesContext) };
  });
  if (!outcome.ok) throw outcome.error;
  return result!.value;
}
