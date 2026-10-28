import { defineModule, gatewayEvent, on, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { Events, GatewayDispatchEvents, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createAutoreactCommand, removeRuleOf } from './commands.js';
import * as schema from './db/schema.js';
import { rules } from './db/schema.js';
import { Reactor } from './reactor.js';
import { RuleIndex } from './rule-index.js';

/** An autoreact module with its own in-memory state; the default export is the one deployments load. */
export function createAutoreactModule(): ModuleDefinition<Record<string, never>, undefined> {
  const index = new RuleIndex();
  const reactor = new Reactor({ index });
  return defineModule<Record<string, never>, undefined>({
    name: 'autoreact',
    docs: new URL('../docs/user/', import.meta.url),
    optionalDependsOn: [sticky, mediaonly],
    intents: [GatewayIntentBits.GuildMessages],
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.UseExternalEmojis,
    ],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => reactor.onMessage(ctx, message)),
      on(Events.ChannelDelete, (ctx, channel) => removeRuleOf(ctx, index, channel.id)),
      // Raw packet: discord.js emits ThreadDelete only for cached threads.
      on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), (ctx, data) => removeRuleOf(ctx, index, data.id)),
    ],
    commands: { autoreact: createAutoreactCommand({ index }) },
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(rules));
        index.replaceGuild(ctx.guildId, rows);
      },
      guildStopped: (ctx) => index.dropGuild(ctx.guildId),
    },
  });
}

export default createAutoreactModule();
