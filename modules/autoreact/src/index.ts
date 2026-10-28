import { channelRuleHooks, channelRuleListeners, ChannelRuleIndex, defineModule, on, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { Events, GatewayIntentBits, PermissionFlagsBits, type GuildMember, type Message, type User } from 'discord.js';
import { createAutoreactCommand } from './commands.js';
import * as schema from './db/schema.js';
import { rules, type Rule } from './db/schema.js';
import { Reactor } from './reactor.js';

export interface AutoreactApi {
  /** Adds the channel rule's emojis to `message` as if `author` had posted it, unless the rule is missing, disabled or ignores the author. Never throws. */
  reactPost(message: Message, author: GuildMember | User): Promise<void>;
}

/** An autoreact module with its own in-memory state; the default export is the one deployments load. */
export function createAutoreactModule(): ModuleDefinition<Record<string, never>, AutoreactApi> {
  const index = new ChannelRuleIndex<Rule>();
  const reactor = new Reactor({ index });
  return defineModule<Record<string, never>, AutoreactApi>({
    name: 'autoreact',
    docs: new URL('../docs/user/', import.meta.url),
    optionalDependsOn: [sticky, mediaonly],
    api: (ctx) => ({ reactPost: (message, author) => reactor.reactPost(ctx, message, author) }),
    // Guild Expressions keeps client.emojis current, which validates custom emojis.
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildExpressions],
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
