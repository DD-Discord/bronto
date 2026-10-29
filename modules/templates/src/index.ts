import { defineModule, type ModuleDefinition } from '@bronto/core';
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { templatesApi, type TemplatesApi } from './api.js';
import { previewComponents } from './buttons.js';
import { createTemplatesCommand } from './commands.js';
import { dropDrafts, editorComponents } from './editor.js';
import * as schema from './db/schema.js';
import { templatesEvents, templatesGates } from './events.js';
import { templateForum } from './lifecycle.js';
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
    listeners: [...templateForum.listeners],
    commands: { templates: createTemplatesCommand() },
    components: [...previewComponents, ...editorComponents],
    api: (ctx) => templatesApi(ctx),
    hooks: {
      // Queued, not awaited: the guild's events and interactions wait for guildReady, and reconcile asks Discord once
      // per template.
      guildReady: (ctx) => {
        void ctx.queue.run('reconcile', (task) => templateForum.reconcile(task));
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
export { escapeLinkText } from '@bronto/core';
export { templatesEvents, templatesGates } from './events.js';
export { fillPlaceholders, postPlaceholders, TIMESTAMP_PLACEHOLDERS } from './placeholders.js';
export { suggestTemplates } from './autocomplete.js';
