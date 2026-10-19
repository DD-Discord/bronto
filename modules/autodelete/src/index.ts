import { defineModule, type ModuleDefinition } from '@bronto/core';
import { GatewayIntentBits, Partials, PermissionFlagsBits, type Client } from 'discord.js';
import { createAutodeleteCommand } from './commands.js';
import { autodeleteConfigSchema, type AutodeleteConfig } from './config.js';
import * as schema from './db/schema.js';
import { rules } from './db/schema.js';
import { createRestAutodeleteDiscord, type AutodeleteDiscord } from './discord.js';
import { RuleIndex } from './rule-index.js';

export interface AutodeleteModuleOptions {
  /** Builds the Discord access from the client; tests pass a fake. */
  discord?: (client: Client) => AutodeleteDiscord;
  /** Clock in milliseconds. */
  now?: () => number;
  /** The rule index the module fills; tests pass one to inspect it. */
  index?: RuleIndex;
}

/** An autodelete module with its own in-memory state; the default export is the one deployments load. */
export function createAutodeleteModule(options: AutodeleteModuleOptions = {}): ModuleDefinition<AutodeleteConfig> {
  const discordFor = options.discord ?? createRestAutodeleteDiscord;
  const discord = (ctx: { client: Client }) => discordFor(ctx.client);
  const index = options.index ?? new RuleIndex();
  return defineModule<AutodeleteConfig>({
    name: 'autodelete',
    // Server Members is a privileged intent.
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.GuildMember],
    config: autodeleteConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [PermissionFlagsBits.ManageMessages],
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
export type { AutodeleteDiscord } from './discord.js';
