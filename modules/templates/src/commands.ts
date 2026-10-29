import { defineCommand, defineSubcommand, recordList, UserError, type CommandDefinition } from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import { templates } from './db/schema.js';
import type { TemplatesContext } from './context.js';
import { templateForum } from './lifecycle.js';

/** The reply of `/templates list`: one link per template, cut to fit a message. */
async function listReply(ctx: TemplatesContext): Promise<string> {
  const rows = await ctx.db.run(async (tx) => tx.select({ name: templates.name, threadId: templates.threadId }).from(templates));
  if (rows.length === 0) {
    const forumId = await templateForum.storedId(ctx);
    return forumId === null
      ? 'No templates yet. Run /templates init to create the template forum.'
      : `No templates yet. Create a post in <#${forumId}>.`;
  }
  return recordList({ guildId: ctx.guildId, rows });
}

export function createTemplatesCommand(): CommandDefinition {
  return defineCommand({
    description: 'Manages message templates',
    permissions: PermissionFlagsBits.Administrator,
    subcommands: {
      list: defineSubcommand({
        description: 'Lists the templates with links to their posts',
        ephemeral: true,
        execute: async (ctx) => {
          await ctx.reply(await listReply(ctx));
        },
      }),
      init: defineSubcommand({
        description: 'Creates the forum that holds the templates',
        execute: async (ctx) => {
          const stored = await templateForum.storedId(ctx);
          if (stored !== null && (await templateForum.channelExists(ctx, stored))) throw new UserError(`Templates already live in <#${stored}>.`);
          const forumId = await templateForum.ensure(ctx);
          await ctx.reply(`Templates now live in <#${forumId}>.`);
        },
      }),
    },
  });
}
