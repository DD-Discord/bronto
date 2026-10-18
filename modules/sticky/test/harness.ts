import {
  createBot,
  createScopedDb,
  moduleRoleName,
  upsertGuild,
  type Bot,
  type LoadedModule,
  type ScopedDb,
} from '@bronto/core';
import { captureLog, FakeClient, type LogLine } from '@bronto/core/testing';
import { eq } from 'drizzle-orm';
import { Events } from 'discord.js';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { stickyConfigSchema, type StickyConfig } from '../src/config.js';
import { stickies, stickyState, type Sticky } from '../src/db/schema.js';
import { createStickyModule } from '../src/index.js';
import type { FakeStickyDiscord } from './fake-discord.js';

// Made-up IDs; tests never use real server data.
export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const CHANNEL = '100000000000000010';
export const THREAD = '100000000000000011';
export const QUIET_CHANNEL = '100000000000000012';
export const TEMPLATE_CHANNEL = '100000000000000020';
export const TEMPLATE_MESSAGE = '100000000000000021';
export const USER = '100000000000000099';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function stickyModule(discord?: FakeStickyDiscord, config: Partial<StickyConfig> = {}): LoadedModule {
  return {
    packageName: '@bronto/sticky',
    definition: createStickyModule(discord === undefined ? {} : { discord: () => discord }),
    config: stickyConfigSchema.parse(config),
  };
}

export interface StickyBot {
  bot: Bot;
  client: FakeClient;
  lines: LogLine[];
}

/** Database access as the sticky module, the way its handlers get it. */
export function stickyDb(t: TestDatabase, guildId = GUILD): ScopedDb {
  return createScopedDb(t.database.app, guildId, moduleRoleName(t.database.appRole, 'sticky'));
}

/** A bot with the sticky module: database migrated and GUILD registered, not yet ready. */
export async function prepareStickyBot(
  t: TestDatabase,
  discord: FakeStickyDiscord,
  options: { config?: Partial<StickyConfig>; extra?: LoadedModule[] } = {},
): Promise<StickyBot> {
  const client = new FakeClient();
  client.guilds.cache.set(GUILD, { id: GUILD, available: true });
  const { log, lines } = captureLog();
  const bot = createBot({
    config: { discord: { token: 'token' }, database: { appUrl: t.appUrl, adminUrl: t.adminUrl }, modules: {}, interactions: {} },
    modules: [stickyModule(discord, options.config), ...(options.extra ?? [])],
    database: t.database,
    client: client.asClient(),
    log,
  });
  await bot.prepare();
  await upsertGuild(t.database.admin, GUILD);
  return { bot, client, lines };
}

/** Logs in and runs the start-up work, as discord.js does after connecting. */
export async function ready({ bot, client }: StickyBot): Promise<void> {
  await bot.start();
  client.emit(Events.ClientReady, client);
  await bot.idle();
}

/** Stores a sticky of GUILD; without webhook values it gets a new webhook on its (parent) channel. */
export async function insertSticky(
  t: TestDatabase,
  discord: FakeStickyDiscord,
  values: Partial<typeof stickies.$inferInsert> & { channelId: string },
): Promise<Sticky> {
  const webhook =
    values.webhookId !== undefined && values.webhookToken !== undefined
      ? { id: values.webhookId, token: values.webhookToken }
      : discord.addWebhook(values.parentChannelId ?? values.channelId);
  const rows = await stickyDb(t).run(async (tx) =>
    tx
      .insert(stickies)
      .values({
        templateChannelId: TEMPLATE_CHANNEL,
        templateMessageId: TEMPLATE_MESSAGE,
        content: 'Read the rules.',
        ...values,
        webhookId: webhook.id,
        webhookToken: webhook.token,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function setState(
  t: TestDatabase,
  channelId: string,
  values: { lastMessageId?: string | null; repostDueAt?: Date | null },
): Promise<void> {
  await stickyDb(t).run(async (tx) => {
    await tx.insert(stickyState).values({ channelId, ...values });
  });
}

export async function stateOf(t: TestDatabase, channelId: string) {
  const [row] = await t.database.admin.select().from(stickyState).where(eq(stickyState.channelId, channelId));
  return row;
}

export async function stickyRows(t: TestDatabase): Promise<Sticky[]> {
  return t.database.admin.select().from(stickies).orderBy(stickies.channelId);
}

let messageIds = 100000000000007000n;

/** A gateway message as the sticky listener sees it. */
export function message(channelId: string, extra: { webhookId?: string; bot?: boolean; system?: boolean } = {}) {
  messageIds += 1n;
  return {
    id: String(messageIds),
    channelId,
    guildId: GUILD,
    webhookId: extra.webhookId ?? null,
    system: extra.system ?? false,
    author: { bot: extra.bot ?? false },
  };
}
