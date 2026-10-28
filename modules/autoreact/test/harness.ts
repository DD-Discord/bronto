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
import { createMediaonlyModule, mediaonlyConfigSchema } from '@bronto/mediaonly';
import { createStickyModule, stickyConfigSchema } from '@bronto/sticky';
import { createTemplatesModule } from '@bronto/templates';
import { ChannelType, Collection, Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules, type Rule } from '../src/db/schema.js';
import { createAutoreactModule } from '../src/index.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const CHANNEL = '100000000000000010';
export const OTHER_CHANNEL = '100000000000000011';
export const THREAD = '100000000000000014';
export const FORUM = '100000000000000015';
export const USER = '100000000000000099';
export const MEMBER = '100000000000000098';
export const IGNORED = '100000000000000097';
/** A custom emoji of GUILD, known to the bot's cache. */
export const CUSTOM_EMOJI = '100000000000000200';
export const CUSTOM = `<:party:${CUSTOM_EMOJI}>`;
/** A custom emoji the bot can't use. */
export const FOREIGN = '<:other:100000000000000201>';

export function autoreactModule(): LoadedModule {
  return { packageName: '@bronto/autoreact', definition: createAutoreactModule(), config: {} };
}

export interface AutoreactBot {
  bot: Bot;
  client: NativeTestClient['client'];
  requests: RecordedRequest[];
  http: FakeDiscordHttp;
  native: NativeTestClient;
  lines: LogLine[];
}

/** Database access as the autoreact module, the way its handlers get it. */
export function autoreactDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'autoreact'));
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
  return [...modules, autoreactModule(), ...(options.extra ?? [])];
}

/** A bot with the autoreact module: database migrated and GUILD (with one custom emoji) registered, not yet ready. */
export async function prepareAutoreactBot(
  t: TestDatabase,
  discord: FakeDiscordHttp,
  options: { sticky?: boolean; mediaonly?: boolean; extra?: LoadedModule[] } = {},
): Promise<AutoreactBot> {
  discord.addGuild(GUILD, { community: true });
  discord.guilds.get(GUILD)!.emojis = [{ id: CUSTOM_EMOJI, name: 'party', animated: false, roles: [], available: true }] as never;
  for (const id of [CHANNEL, OTHER_CHANNEL]) {
    if (!discord.channels.has(id)) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  }
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
export async function ready({ bot, native }: AutoreactBot): Promise<void> {
  await bot.start();
  native.ready();
  await bot.idle();
}

/** Runs a slash command in GUILD as USER and waits for its work. */
export async function runCommand(
  ab: AutoreactBot,
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
  const rows = await autoreactDb(t, guildId).run(async (tx) => tx.insert(rules).values({ emojis: ['\u{1F44D}'], ...values }).returning());
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
}

let nextId = 100000000000800000n;

/** A gateway message in GUILD with only the parts the module reads; mediaonly's check reads `member` and `attachments`. */
export function fakeMessage(channelId: string, options: FakeMessageOptions = {}) {
  const id = String(nextId++);
  const authorId = options.authorId ?? MEMBER;
  const attachments = new Collection(
    Array.from({ length: options.attachments ?? 0 }, (_, index) => {
      const attachmentId = `${id}${index}`;
      return [attachmentId, { id: attachmentId, name: `photo${index}.png`, spoiler: false }] as const;
    }),
  );
  const author = { id: authorId, bot: options.bot ?? false };
  return {
    id,
    channelId,
    guildId: GUILD,
    content: options.content ?? 'Hello there',
    attachments,
    webhookId: options.webhookId ?? null,
    system: options.system ?? false,
    author,
    member: { id: authorId, user: author, permissionsIn: () => ({ has: () => false }) },
  };
}
