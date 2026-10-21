import { defineCommand, defineSubcommand, UserError, type CommandDefinition } from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import { channelExists, ensureForum, storedForumId } from './forum.js';

export function createTemplatesCommand(): CommandDefinition {
  return defineCommand({
    description: 'Manages message templates',
    permissions: PermissionFlagsBits.Administrator,
    subcommands: {
      init: defineSubcommand({
        description: 'Creates the forum that holds the templates',
        execute: async (ctx) => {
          const stored = await storedForumId(ctx);
          if (stored !== null && (await channelExists(ctx, stored))) throw new UserError(`Templates already live in <#${stored}>.`);
          const forumId = await ensureForum(ctx);
          await ctx.reply(`Templates now live in <#${forumId}>.`);
        },
      }),
    },
  });
}
