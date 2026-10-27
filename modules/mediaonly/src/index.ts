import { defineModule, gatewayEvent, on, type ModuleDefinition } from '@bronto/core';
import sticky from '@bronto/sticky';
import { Events, GatewayDispatchEvents, GatewayIntentBits, PermissionFlagsBits, type Message } from 'discord.js';
import { rejection } from './check.js';
import { createMediaonlyCommand, removeRuleOf } from './commands.js';
import { mediaonlyConfigSchema, type MediaonlyConfig } from './config.js';
import * as schema from './db/schema.js';
import { rules } from './db/schema.js';
import { Enforcer } from './enforcer.js';
import { RuleIndex } from './rule-index.js';

export interface MediaonlyApi {
  /**
   * Whether mediaonly deletes this message: true exactly when the enforcer does. In memory only, so the answer doesn't
   * depend on which module's listener runs first.
   */
  rejects(message: Message): boolean;
}

/** A mediaonly module with its own in-memory state; the default export is the one deployments load. */
export function createMediaonlyModule(): ModuleDefinition<MediaonlyConfig, MediaonlyApi> {
  const index = new RuleIndex();
  const enforcer = new Enforcer({ index });
  return defineModule<MediaonlyConfig, MediaonlyApi>({
    name: 'mediaonly',
    docs: new URL('../docs/user/', import.meta.url),
    optionalDependsOn: [sticky],
    // Message Content is a privileged intent; without it text and attachments arrive empty.
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    config: mediaonlyConfigSchema,
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    api: (ctx) => ({ rejects: (message) => rejection(ctx, index, message) !== null }),
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageWebhooks,
    ],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => enforcer.onMessage(ctx, message)),
      on(Events.ChannelDelete, (ctx, channel) => removeRuleOf(ctx, index, channel.id)),
      // Raw packet: discord.js emits ThreadDelete only for cached threads.
      on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), (ctx, data) => removeRuleOf(ctx, index, data.id)),
    ],
    commands: { mediaonly: createMediaonlyCommand({ index }) },
    hooks: {
      guildReady: async (ctx) => {
        const rows = await ctx.db.run(async (tx) => tx.select().from(rules));
        index.replaceGuild(ctx.guildId, rows);
      },
      guildStopped: (ctx) => {
        index.dropGuild(ctx.guildId);
        enforcer.stopGuild(ctx.guildId);
      },
    },
  });
}

export default createMediaonlyModule();
export { mediaonlyConfigSchema, type MediaonlyConfig } from './config.js';
export { mediaProblem, type MediaProblem } from './check.js';
export { NOTICE_MS } from './enforcer.js';
