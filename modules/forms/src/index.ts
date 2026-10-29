import autoreact from '@bronto/autoreact';
import autothread from '@bronto/autothread';
import { answer, defineModule, gate, on, type ModuleDefinition } from '@bronto/core';
import sticky, { stickyAsks, stickyEvents } from '@bronto/sticky';
import templates, { templatesEvents, templatesGates } from '@bronto/templates';
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { previewComponents, registerPreviewActions } from './buttons.js';
import { editorComponents, openAddField, openEditField } from './editor.js';
import { createFormsCommand } from './commands.js';
import * as schema from './db/schema.js';
import { formsEvents } from './events.js';
import { formForum } from './lifecycle.js';
import { DRAFT_SWEEP_MS, sweepDrafts } from './drafts.js';
import { fillComponents, openTrial } from './fill.js';
import { openButton } from './open.js';
import { channelsUsingTemplate, dropStickyOpeners, dropTemplateOpeners, openerRows, refreshTemplateMessages, stickyOpenersOf } from './openers.js';
import { removeOpenerSelect } from './post.js';
import { dropDrafts, tryAgainButton } from './retry.js';
import { openSettings, settingsModalDefinition } from './settings.js';
import { discardPostButton, retryPostButton } from './submit.js';
import { askDelete, exportFormFile, openImport, transferComponents } from './transfer.js';

registerPreviewActions({
  'add-field': openAddField,
  'edit-field': openEditField,
  settings: openSettings,
  try: openTrial,
  export: exportFormFile,
  import: openImport,
  delete: askDelete,
});

/** The forms module; the default export is the one deployments load. */
export function createFormsModule(): ModuleDefinition<Record<string, never>, undefined> {
  // The draft sweep of each server; per module instance, so bots in one process keep their own.
  const sweeps = new Map<string, NodeJS.Timeout>();
  return defineModule<Record<string, never>, undefined>({
    name: 'forms',
    docs: new URL('../docs/user/', import.meta.url),
    dependsOn: [templates],
    optionalDependsOn: [sticky, autothread, autoreact],
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
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
    events: formsEvents,
    listeners: [
      ...formForum.listeners,
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
    components: [...previewComponents, ...editorComponents, settingsModalDefinition, ...transferComponents, tryAgainButton, openButton, removeOpenerSelect, ...fillComponents, retryPostButton, discardPostButton],
    hooks: {
      // Queued, not awaited: the guild's events and interactions wait for guildReady, and reconcile asks Discord once
      // per form.
      guildReady: (ctx) => {
        void ctx.queue.run('reconcile', (task) => formForum.reconcile(task));
        clearInterval(sweeps.get(ctx.guildId));
        // The timer keeps the ctx that started it; queue.run starts a new handler run each time it fires.
        const timer = setInterval(() => {
          void ctx.queue.run('sweep-drafts', (task) => sweepDrafts(task));
        }, DRAFT_SWEEP_MS);
        timer.unref();
        sweeps.set(ctx.guildId, timer);
      },
      guildStopped: (ctx) => {
        dropDrafts(ctx.guildId);
        clearInterval(sweeps.get(ctx.guildId));
        sweeps.delete(ctx.guildId);
      },
    },
  });
}

export default createFormsModule();
export { formsEvents } from './events.js';
