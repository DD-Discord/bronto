import { defineModule, gatewayEvent, on, type ModuleDefinition } from '@bronto/core';
import sticky from '@bronto/sticky';
import templates from '@bronto/templates';
import { Events, GatewayDispatchEvents, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { previewComponents } from './buttons.js';
import { editorComponents } from './editor.js';
import { createFormsCommand } from './commands.js';
import * as schema from './db/schema.js';
import { onChannelDelete, onThreadDelete, onThreadUpdate, reconcile } from './lifecycle.js';
import { onThreadCreate } from './new-post.js';
import { dropDrafts, tryAgainButton } from './retry.js';
import { settingsModalDefinition } from './settings.js';
import { transferComponents } from './transfer.js';

/** The forms module; the default export is the one deployments load. */
export function createFormsModule(): ModuleDefinition<Record<string, never>, undefined> {
  return defineModule<Record<string, never>, undefined>({
    name: 'forms',
    dependsOn: [templates],
    optionalDependsOn: [sticky],
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ],
    listeners: [
      on(Events.ThreadCreate, (ctx, thread, newlyCreated) => onThreadCreate(ctx, thread, newlyCreated)),
      // Raw packet: discord.js emits ThreadDelete only for cached threads.
      on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), (ctx, data) => onThreadDelete(ctx, data)),
      on(Events.ChannelDelete, (ctx, channel) => onChannelDelete(ctx, channel)),
      on(Events.ThreadUpdate, (ctx, before, after) => onThreadUpdate(ctx, before, after)),
    ],
    commands: { forms: createFormsCommand() },
    components: [...previewComponents, ...editorComponents, settingsModalDefinition, ...transferComponents, tryAgainButton],
    hooks: {
      // Queued, not awaited: the guild's events and interactions wait for guildReady, and reconcile asks Discord once
      // per form.
      guildReady: (ctx) => {
        void ctx.queue.run('reconcile', (task) => reconcile(task));
      },
      guildStopped: (ctx) => {
        dropDrafts(ctx.guildId);
      },
    },
  });
}

export default createFormsModule();
