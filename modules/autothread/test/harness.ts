import {
  createBot,
  createScopedDb,
  moduleRoleName,
  upsertGuild,
  type Bot,
  type HandlerContext,
  type LoadedModule,
  type ScopedDb,
} from '@bronto/core';
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
import { createMediaonlyModule, mediaonlyConfigSchema } from '@bronto/mediaonly';
import { createStickyModule, stickyConfigSchema } from '@bronto/sticky';
import templates, { createTemplatesModule } from '@bronto/templates';
import { ChannelType, Collection, Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules, type Rule } from '../src/db/schema.js';
import { createAutothreadModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const CHANNEL = '100000000000000010';
export const OTHER_CHANNEL = '100000000000000011';
export const NEWS = '100000000000000012';
export const FORUM = '100000000000000015';
export const USER = '100000000000000099';
export const MEMBER = '100000000000000098';

export function autothreadModule(): LoadedModule {
  return { packageName: '@bronto/autothread', definition: createAutothreadModule(), config: {} };
}

export interface AutothreadBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Database access as the autothread module, the way its handlers get it. */
export function autothreadDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'autothread'));
}

/** Templates always load; sticky and mediaonly only when asked for. */
function modulesFor(options: { sticky?: boolean; mediaonly?: boolean; extra?: LoadedModule[] }): LoadedModule[] {
  const modules: LoadedModule[] = [{ packageName: '@bronto/templates', definition: createTemplatesModule(), config: {} }];
  if (options.sticky === true) {
    modules.push({ packageName: '@bronto/sticky', definition: createStickyModule(), config: stickyConfigSchema.parse({}) });
  }
  if (options.mediaonly === true) {
    modules.push({ packageName: '@bronto/mediaonly', definition: createMediaonlyModule(), config: mediaonlyConfigSchema.parse({}) });
  }
  return [...modules, autothreadModule(), ...(options.extra ?? [])];
}

/** A bot with the autothread module: database migrated and GUILD registered, not yet ready. */
export async function prepareAutothreadBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { sticky?: boolean; mediaonly?: boolean; extra?: LoadedModule[] } = {},
): Promise<AutothreadBot> {
  discord.addGuild(GUILD, { community: true });
  for (const id of [CHANNEL, OTHER_CHANNEL]) {
    if (!discord.channels.has(id)) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  }
  if (!discord.channels.has(NEWS)) discord.addChannel(NEWS, { guildId: GUILD, type: ChannelType.GuildAnnouncement });
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
export async function ready({ bot, native }: AutothreadBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs a slash command in GUILD as USER and waits for its work. */
export async function runCommand(
  ab: AutothreadBot,
  command: string,
  subcommand: string,
  options: Record<string, unknown> = {},
  channelId = CHANNEL,
): Promise<FakeInteraction> {
  const fake = fakeCommand({ command, subcommand, guildId: GUILD, channelId, userId: USER, options });
  ab.client.emit(Events.InteractionCreate, fake);
  await ab.bot.idle();
  return fake;
}

/** A channel option value as discord.js resolves it. */
export const channelOption = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

export async function insertRule(
  t: TestDatabase,
  values: Partial<typeof rules.$inferInsert> & { channelId: string },
  guildId = GUILD,
): Promise<Rule> {
  const rows = await autothreadDb(t, guildId).run(async (tx) => tx.insert(rules).values(values).returning());
  return rows[0]!;
}

export const ruleRows = (t: TestDatabase): Promise<Rule[]> => t.database.admin.select().from(rules).orderBy(rules.channelId);

export interface FakeMessageOptions {
  content?: string;
  /** Number of attachments. */
  attachments?: number;
  authorId?: string;
  bot?: boolean;
  webhookId?: string | null;
  system?: boolean;
  displayName?: string;
}

let nextId = 100000000000800000n;

/** A gateway message in GUILD with only the parts the module reads: placeholders, and mediaonly's check reads `member` and `attachments`. */
export function fakeMessage(channelId: string, options: FakeMessageOptions = {}) {
  const id = String(nextId++);
  const authorId = options.authorId ?? MEMBER;
  const attachments = new Collection(
    Array.from({ length: options.attachments ?? 0 }, (_, index) => {
      const attachmentId = `${id}${index}`;
      return [attachmentId, { id: attachmentId, name: `photo${index}.png`, spoiler: false }] as const;
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
    url: `https://discord.com/channels/${GUILD}/${channelId}/${id}`,
    createdTimestamp: Date.now(),
    channel: { name: 'general' },
    guild: { name: 'Test server' },
    author: { id: authorId, bot: options.bot ?? false, username: 'mia', displayName: 'Mia' },
    member: { id: authorId, displayName: options.displayName ?? 'Mia Display', permissionsIn: () => ({ has: () => false }) },
  };
}

/** Runs `run` as the given module, the way its own handlers do. */
async function asModule(ab: AutothreadBot, name: string, run: (ctx: HandlerContext) => Promise<void>): Promise<void> {
  const runtime = ab.bot.runtimes.find((entry) => entry.name === name)!;
  const outcome = await ab.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', run);
  if (!outcome.ok) throw outcome.error;
  await ab.bot.idle();
}

/** Runs `run` as the templates module, which emits its events and asks its gates. */
export const asTemplates = (ab: AutothreadBot, run: (ctx: HandlerContext) => Promise<void>) => asModule(ab, 'templates', run);

/** Creates a template through the templates API and returns its ID. */
export async function createTemplate(ab: AutothreadBot, name: string, content: string, embed: object | null = null): Promise<string> {
  let id = '';
  await asModule(ab, 'autothread', async (ctx) => {
    id = (await ctx.modules.get(templates).create({ name, content, embed })).id;
  });
  return id;
}
