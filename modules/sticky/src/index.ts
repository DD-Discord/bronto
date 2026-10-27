import { defineModule, gate, on, type ModuleDefinition } from '@bronto/core';
import templates, { templatesEvents, templatesGates } from '@bronto/templates';
import { Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { asc, eq } from 'drizzle-orm';
import { createStickyCommand } from './commands.js';
import { stickyConfigSchema, type StickyConfig } from './config.js';
import * as schema from './db/schema.js';
import { stickies } from './db/schema.js';
import { stickyApi, type StickyApi } from './api.js';
import { stickyAsks, stickyEvents } from './events.js';
import { adoptLegacyStickies } from './migrate.js';
import { Reposter } from './repost.js';
import { entryOf, StickyIndex } from './sticky-index.js';

/** A sticky module with its own in-memory state; the default export is the one deployments load. */
export function createStickyModule(): ModuleDefinition<StickyConfig, StickyApi> {
  const index = new StickyIndex();
  const reposter = new Reposter({ index });
  return defineModule<StickyConfig, StickyApi>({
    name: 'sticky',
    docs: new URL('../docs/user/', import.meta.url),
    dependsOn: [templates],
    intents: [GatewayIntentBits.GuildMessages],
    config: stickyConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    events: stickyEvents,
    asks: stickyAsks,
    api: (ctx) => stickyApi(ctx, { index, reposter }),
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => reposter.onMessage(ctx, message)),
      on(templatesEvents.updated, (ctx, { id }) => reposter.refreshTemplate(ctx, id)),
      on(templatesEvents.deleted, (ctx, { id }) => reposter.deleteForTemplate(ctx, id)),
      gate(templatesGates.deleting, async (ctx, { id }) => {
        const users = await ctx.db.run(async (tx) =>
          tx.select({ channelId: stickies.channelId }).from(stickies).where(eq(stickies.templateId, id)).orderBy(asc(stickies.channelId)),
        );
        if (users.length > 0) return { deny: `Used by the stickies in ${users.map(({ channelId }) => `<#${channelId}>`).join(', ')}` };
      }),
    ],
    commands: { sticky: createStickyCommand({ index, reposter }) },
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(stickies));
        for (const removed of index.replaceGuild(ctx.guildId, rows.map(entryOf))) reposter.cancel(removed.channelId);
        await reposter.resume(ctx);
        // Queued, not awaited: the guild's events and interactions wait for guildReady, and both steps call Discord
        // per sticky. Stickies move one after another, then those whose template is gone are deleted.
        void ctx.queue.run('adopt', async (task) => {
          await adoptLegacyStickies(task);
          await reposter.deleteWithoutTemplate(task);
        });
      },
      guildStopped: (ctx) => {
        for (const removed of index.dropGuild(ctx.guildId)) reposter.cancel(removed.channelId);
      },
    },
  });
}

export default createStickyModule();
export { stickyConfigSchema, type StickyConfig } from './config.js';
export type { StickyApi } from './api.js';
export { stickyAsks, stickyEvents } from './events.js';
