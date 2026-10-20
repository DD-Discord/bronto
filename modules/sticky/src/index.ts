import { defineModule, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createStickyCommand } from './commands.js';
import { stickyConfigSchema, type StickyConfig } from './config.js';
import * as schema from './db/schema.js';
import { stickies } from './db/schema.js';
import { stickyEvents } from './events.js';
import { Reposter } from './repost.js';
import { entryOf, StickyIndex } from './sticky-index.js';

/** A sticky module with its own in-memory state; the default export is the one deployments load. */
export function createStickyModule(): ModuleDefinition<StickyConfig> {
  const index = new StickyIndex();
  const reposter = new Reposter({ index });
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
    commands: { sticky: createStickyCommand({ index, reposter }) },
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(stickies));
        for (const removed of index.replaceGuild(ctx.guildId, rows.map(entryOf))) reposter.cancel(removed.channelId);
        await reposter.resume(ctx);
      },
      guildStopped: (ctx) => {
        for (const removed of index.dropGuild(ctx.guildId)) reposter.cancel(removed.channelId);
      },
    },
  });
}

export default createStickyModule();
export { stickyConfigSchema, type StickyConfig } from './config.js';
export { stickyEvents } from './events.js';
