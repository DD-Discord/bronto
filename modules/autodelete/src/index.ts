import { channelRuleHooks, channelRuleListeners, ChannelRuleIndex, defineModule, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { cleanUpRemovedRule, createAutodeleteCommand } from './commands.js';
import { autodeleteConfigSchema, type AutodeleteConfig } from './config.js';
import * as schema from './db/schema.js';
import { rules, type Rule } from './db/schema.js';
import { Tracker } from './tracker.js';

/** An autodelete module with its own in-memory state; the default export is the one deployments load. */
export function createAutodeleteModule(): ModuleDefinition<AutodeleteConfig> {
  const index = new ChannelRuleIndex<Rule>();
  const tracker = new Tracker({ index });
  return defineModule<AutodeleteConfig>({
    name: 'autodelete',
    docs: new URL('../docs/user/', import.meta.url),
    // Server Members is a privileged intent.
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.GuildMember],
    config: autodeleteConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => tracker.onMessage(ctx, message)),
      on(Events.MessageDelete, (ctx, message) => tracker.onDelete(ctx, message.channelId, [message.id])),
      on(Events.MessageBulkDelete, (ctx, messages, channel) => tracker.onDelete(ctx, channel.id, [...messages.keys()])),
      on(Events.GuildMemberRemove, (ctx, member) => tracker.onLeave(ctx, member)),
      ...channelRuleListeners({ table: rules, index, onRemoved: cleanUpRemovedRule }),
    ],
    commands: { autodelete: createAutodeleteCommand({ index }) },
    hooks: channelRuleHooks({ table: rules, index }),
  });
}

export default createAutodeleteModule();
export { autodeleteConfigSchema, type AutodeleteConfig } from './config.js';
export type { DeleteOutcome, FetchedPost } from './discord.js';
export type { MemberInfo, Removal } from './tracker.js';
