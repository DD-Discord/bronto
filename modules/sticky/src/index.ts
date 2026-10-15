import { defineModule, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayIntentBits, PermissionFlagsBits, type Client } from 'discord.js';
import { createStickyCommand } from './commands.js';
import { stickyConfigSchema, type StickyConfig } from './config.js';
import * as schema from './db/schema.js';
import { stickies } from './db/schema.js';
import { createRestStickyDiscord, type StickyDiscord } from './discord.js';
import { stickyEvents } from './events.js';
import { removeGuildPosts, Reposter } from './repost.js';
import { entryOf, StickyIndex } from './sticky-index.js';

export interface StickyModuleOptions {
  /** Builds the Discord access from the client; tests pass a fake. */
  discord?: (client: Client) => StickyDiscord;
  /** Clock in milliseconds. */
  now?: () => number;
}

/** A sticky module with its own in-memory state; the default export is the one deployments load. */
export function createStickyModule(options: StickyModuleOptions = {}): ModuleDefinition<StickyConfig> {
  const discordFor = options.discord ?? createRestStickyDiscord;
  const discord = (ctx: { client: Client }) => discordFor(ctx.client);
  const index = new StickyIndex();
  const reposter = new Reposter({ index, discord, now: options.now });
  return defineModule<StickyConfig>({
    name: 'sticky',
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    config: stickyConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    events: stickyEvents,
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    listeners: [on(Events.MessageCreate, (ctx, message) => reposter.onMessage(ctx, message))],
    commands: [createStickyCommand({ index, reposter, discord })],
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(stickies));
        for (const removed of index.replaceGuild(ctx.guildId, rows.map(entryOf))) reposter.cancel(removed.channelId);
        await reposter.resume(ctx);
      },
      guildStopped: (ctx) => {
        for (const removed of index.dropGuild(ctx.guildId)) reposter.cancel(removed.channelId);
      },
      deleteGuildData: (ctx) => removeGuildPosts(ctx, discord(ctx)),
    },
  });
}

export default createStickyModule();
export { stickyConfigSchema, type StickyConfig } from './config.js';
export type { StickyDiscord } from './discord.js';
export { stickyEvents } from './events.js';
