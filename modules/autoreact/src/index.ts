import { channelRuleHooks, channelRuleListeners, ChannelRuleIndex, defineModule, on, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createAutoreactCommand } from './commands.js';
import * as schema from './db/schema.js';
import { rules, type Rule } from './db/schema.js';
import { Reactor } from './reactor.js';

/** An autoreact module with its own in-memory state; the default export is the one deployments load. */
export function createAutoreactModule(): ModuleDefinition<Record<string, never>, undefined> {
  const index = new ChannelRuleIndex<Rule>();
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
      ...channelRuleListeners({ table: rules, index }),
    ],
    commands: { autoreact: createAutoreactCommand({ index }) },
    hooks: channelRuleHooks({ table: rules, index }),
  });
}

export default createAutoreactModule();
