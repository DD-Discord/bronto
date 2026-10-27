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
import { createStickyModule, stickyConfigSchema } from '@bronto/sticky';
import { createTemplatesModule } from '@bronto/templates';
import { ChannelType } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import type { FormsContext } from '../src/context.js';
import { createFormsModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const FORUM = '100000000000000010';
export const USER = '100000000000000099';

export function formsModule(): LoadedModule {
  return { packageName: '@bronto/forms', definition: createFormsModule(), config: {} };
}

export interface FormsBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Database access as the forms module, the way its handlers get it. */
export function formsDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'forms'));
}

/** Forms depends on templates and optionally on sticky, which loads only with `sticky: true`. */
function modulesFor(sticky: boolean): LoadedModule[] {
  const templates: LoadedModule = { packageName: '@bronto/templates', definition: createTemplatesModule(), config: {} };
  const stickyModule: LoadedModule[] = sticky
    ? [{ packageName: '@bronto/sticky', definition: createStickyModule(), config: stickyConfigSchema.parse({}) }]
    : [];
  return [templates, ...stickyModule, formsModule()];
}

/**
 * A bot with the forms and templates modules (and sticky with `sticky: true`): database migrated and GUILD (a
 * community server unless `community` is false, with a forum) registered, not yet ready.
 */
export async function prepareFormsBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { extra?: LoadedModule[]; sticky?: boolean; community?: boolean } = {},
): Promise<FormsBot> {
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
    modules: [...modulesFor(options.sticky ?? false), ...(options.extra ?? [])],
    database: t.database,
    client,
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines, requests, native, http: discord };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, native }: FormsBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs `fn` as a forms handler of GUILD and returns its result. */
export async function inHandler<T>(fb: FormsBot, fn: (ctx: FormsContext) => Promise<T>): Promise<T> {
  const runtime = fb.bot.runtimes.find((entry) => entry.name === 'forms')!;
  let result: { value: T } | undefined;
  const outcome = await fb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
    result = { value: await fn(ctx as FormsContext) };
  });
  if (!outcome.ok) throw outcome.error;
  return result!.value;
}
