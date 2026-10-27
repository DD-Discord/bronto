import { answer, defineModule, gate, gatewayEvent, on, type ModuleDefinition } from '@bronto/core';
import sticky, { stickyAsks, stickyEvents } from '@bronto/sticky';
import templates, { templatesEvents, templatesGates } from '@bronto/templates';
import { Events, GatewayDispatchEvents, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { previewComponents, registerPreviewActions } from './buttons.js';
import { editorComponents, openAddField, openEditField } from './editor.js';
import { createFormsCommand } from './commands.js';
import * as schema from './db/schema.js';
import { onChannelDelete, onThreadDelete, onThreadUpdate, reconcile } from './lifecycle.js';
import { onThreadCreate } from './new-post.js';
import { openButton } from './open.js';
import { channelsUsingTemplate, dropStickyOpeners, dropTemplateOpeners, openerRows, refreshTemplateMessages, stickyOpenersOf } from './openers.js';
import { removeOpenerSelect } from './post.js';
import { dropDrafts, tryAgainButton } from './retry.js';
import { openSettings, settingsModalDefinition } from './settings.js';
import { askDelete, exportFormFile, openImport, transferComponents } from './transfer.js';

registerPreviewActions({
  'add-field': openAddField,
  'edit-field': openEditField,
  settings: openSettings,
  export: exportFormFile,
  import: openImport,
  delete: askDelete,
});

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
      answer(stickyAsks.components, async (ctx, { channelId }) => openerRows(ctx, await stickyOpenersOf(ctx, channelId))),
      on(stickyEvents.deleted, (ctx, { channelId }) => dropStickyOpeners(ctx, channelId)),
      on(templatesEvents.updated, (ctx, { id }) => refreshTemplateMessages(ctx, id)),
      on(templatesEvents.deleted, (ctx, { id }) => dropTemplateOpeners(ctx, id)),
      gate(templatesGates.deleting, async (ctx, { id }) => {
        const channels = await channelsUsingTemplate(ctx, id);
        if (channels.length > 0) return { deny: `Used by form buttons in ${channels.map((channelId) => `<#${channelId}>`).join(', ')}` };
      }),
    ],
    commands: { forms: createFormsCommand() },
    components: [...previewComponents, ...editorComponents, settingsModalDefinition, ...transferComponents, tryAgainButton, openButton, removeOpenerSelect],
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
