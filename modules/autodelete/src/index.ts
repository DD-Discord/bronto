import { defineModule, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayIntentBits, Partials, PermissionFlagsBits, type Client } from 'discord.js';
import { createAutodeleteCommand } from './commands.js';
import { autodeleteConfigSchema, type AutodeleteConfig } from './config.js';
import * as schema from './db/schema.js';
import { rules } from './db/schema.js';
import { createRestAutodeleteDiscord, type AutodeleteDiscord } from './discord.js';
import { RuleIndex } from './rule-index.js';
import { silentNotifier, Tracker, type Notifier } from './tracker.js';

export interface AutodeleteModuleOptions {
  /** Builds the Discord access from the client; tests pass a fake. */
  discord?: (client: Client) => AutodeleteDiscord;
  /** Clock in milliseconds. */
  now?: () => number;
  /** The rule index the module fills; tests pass one to inspect it. */
  index?: RuleIndex;
  /** Reports and DMs about removed posts. */
  notifier?: Notifier;
}

/** An autodelete module with its own in-memory state; the default export is the one deployments load. */
export function createAutodeleteModule(options: AutodeleteModuleOptions = {}): ModuleDefinition<AutodeleteConfig> {
  const discordFor = options.discord ?? createRestAutodeleteDiscord;
  const discord = (ctx: { client: Client }) => discordFor(ctx.client);
  const index = options.index ?? new RuleIndex();
  const tracker = new Tracker({ index, discord, notifier: options.notifier ?? silentNotifier, now: options.now });
  return defineModule<AutodeleteConfig>({
    name: 'autodelete',
    // Server Members is a privileged intent.
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.GuildMember],
    config: autodeleteConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [PermissionFlagsBits.ManageMessages],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => tracker.onMessage(ctx, message)),
      on(Events.MessageDelete, (ctx, message) => tracker.onDelete(ctx, message.channelId, [message.id])),
      on(Events.MessageBulkDelete, (ctx, messages, channel) => tracker.onDelete(ctx, channel.id, [...messages.keys()])),
      on(Events.GuildMemberRemove, (ctx, member) => tracker.onLeave(ctx, member)),
    ],
    commands: { autodelete: createAutodeleteCommand({ index, discord }) },
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(rules));
        index.replaceGuild(ctx.guildId, rows);
      },
      guildStopped: (ctx) => {
        index.dropGuild(ctx.guildId);
      },
    },
  });
}

export default createAutodeleteModule();
export { autodeleteConfigSchema, type AutodeleteConfig } from './config.js';
export type { AutodeleteDiscord, DeleteOutcome, FetchedPost } from './discord.js';
export type { MemberInfo, Notifier, Removal } from './tracker.js';
