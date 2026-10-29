import { defineModule, gatewayEvent, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayDispatchEvents, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { templatesApi, type TemplatesApi } from './api.js';
import { previewComponents } from './buttons.js';
import { createTemplatesCommand } from './commands.js';
import { dropDrafts, editorComponents } from './editor.js';
import * as schema from './db/schema.js';
import { templatesEvents, templatesGates } from './events.js';
import { onChannelDelete, onThreadDelete, onThreadUpdate, reconcile } from './lifecycle.js';
import { onThreadCreate } from './new-post.js';
import { dropWaitingUploads } from './save.js';

/** The templates module; the default export is the one deployments load. */
export function createTemplatesModule(): ModuleDefinition<Record<string, never>, TemplatesApi> {
  return defineModule<Record<string, never>, TemplatesApi>({
    name: 'templates',
    docs: new URL('../docs/user/', import.meta.url),
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
    events: templatesEvents,
    gates: templatesGates,
    listeners: [
      on(Events.ThreadCreate, (ctx, thread, newlyCreated) => onThreadCreate(ctx, thread, newlyCreated)),
      // Raw packet: discord.js emits ThreadDelete only for cached threads.
      on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), (ctx, data) => onThreadDelete(ctx, data)),
      on(Events.ChannelDelete, (ctx, channel) => onChannelDelete(ctx, channel)),
      on(Events.ThreadUpdate, (ctx, before, after) => onThreadUpdate(ctx, before, after)),
    ],
    commands: { templates: createTemplatesCommand() },
    components: [...previewComponents, ...editorComponents],
    api: (ctx) => templatesApi(ctx),
    hooks: {
      // Queued, not awaited: the guild's events and interactions wait for guildReady, and reconcile asks Discord once
      // per template.
      guildReady: (ctx) => {
        void ctx.queue.run('reconcile', (task) => reconcile(task));
      },
      // Drafts and uploads waiting for a redraw are kept in memory per guild.
      guildStopped: (ctx) => {
        dropDrafts(ctx.guildId);
        dropWaitingUploads(ctx.guildId);
      },
    },
  });
}

export default createTemplatesModule();
export type { TemplatesApi } from './api.js';
export type { TemplateMessage } from './content.js';
export type { ImageSlot, Template, TemplateImage } from './db/schema.js';
export { escapeLinkText } from './commands.js';
export { templatesEvents, templatesGates } from './events.js';
export { fillPlaceholders, postPlaceholders, TIMESTAMP_PLACEHOLDERS } from './placeholders.js';
export { suggestTemplates } from './autocomplete.js';
