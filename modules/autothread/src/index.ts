import { channelRuleHooks, channelRuleListeners, ChannelRuleIndex, defineModule, gate, on, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import templates, { templatesEvents, templatesGates } from '@bronto/templates';
import { Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { asc, eq } from 'drizzle-orm';
import { createAutothreadCommand } from './commands.js';
import * as schema from './db/schema.js';
import { rules, type Rule } from './db/schema.js';
import { createRename } from './rename.js';
import { Threader } from './threader.js';

/** An autothread module with its own in-memory state; the default export is the one deployments load. */
export function createAutothreadModule(): ModuleDefinition<Record<string, never>, undefined> {
  const index = new ChannelRuleIndex<Rule>();
  const rename = createRename();
  const threader = new Threader({ index, rename });
  return defineModule<Record<string, never>, undefined>({
    name: 'autothread',
    docs: new URL('../docs/user/', import.meta.url),
    dependsOn: [templates],
    optionalDependsOn: [sticky, mediaonly],
    intents: [GatewayIntentBits.GuildMessages],
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ManageThreads,
    ],
    listeners: [
      on(Events.MessageCreate, (ctx, message) => threader.onMessage(ctx, message)),
      ...channelRuleListeners({ table: rules, index }),
      gate(templatesGates.deleting, async (ctx, { id }) => {
        const users = await ctx.db.run(async (tx) =>
          tx.select({ channelId: rules.channelId }).from(rules).where(eq(rules.templateId, id)).orderBy(asc(rules.channelId)),
        );
        if (users.length > 0) return { deny: `Used by the auto-threads in ${users.map(({ channelId }) => `<#${channelId}>`).join(', ')}` };
      }),
      on(templatesEvents.deleted, async (ctx, { id }) => {
        const cleared = await ctx.db.run(async (tx) => tx.update(rules).set({ templateId: null }).where(eq(rules.templateId, id)).returning());
        for (const rule of cleared) index.set(rule);
      }),
    ],
    components: [rename.renameButton, rename.renameModal],
    commands: { autothread: createAutothreadCommand({ index }) },
    hooks: channelRuleHooks({ table: rules, index, onStopped: (ctx) => rename.dropGuild(ctx.guildId) }),
  });
}

export default createAutothreadModule();
