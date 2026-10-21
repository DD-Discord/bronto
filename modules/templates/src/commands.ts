import { defineCommand, defineSubcommand, UserError, type CommandDefinition } from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import { templates } from './db/schema.js';
import type { TemplatesContext } from './context.js';
import { channelExists, ensureForum, storedForumId } from './forum.js';

const MAX_LISTED = 50;
// Discord's limit for message content.
const MAX_CONTENT = 2000;

/** Escapes the characters that would end a Markdown link's text or target early, e.g. in a template name. */
export function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]()]/g, '\\$&');
}

const moreLine = (count: number) => `…and ${count} more`;

/** The reply of `/templates list`: one link per template, cut to fit a message. */
async function listReply(ctx: TemplatesContext): Promise<string> {
  const rows = await ctx.db.run(async (tx) => tx.select({ name: templates.name, threadId: templates.threadId }).from(templates));
  if (rows.length === 0) {
    const forumId = await storedForumId(ctx);
    return forumId === null
      ? 'No templates yet. Run /templates init to create the template forum.'
      : `No templates yet. Create a post in <#${forumId}>.`;
  }
  rows.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const lines: string[] = [];
  for (const row of rows.slice(0, MAX_LISTED)) {
    const line = `[${escapeLinkText(row.name)}](https://discord.com/channels/${ctx.guildId}/${row.threadId})`;
    const rest = rows.length - lines.length - 1;
    const text = [...lines, line].join('\n') + (rest > 0 ? `\n${moreLine(rest)}` : '');
    if (text.length > MAX_CONTENT) break;
    lines.push(line);
  }
  if (lines.length < rows.length) lines.push(moreLine(rows.length - lines.length));
  return lines.join('\n');
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
          const stored = await storedForumId(ctx);
          if (stored !== null && (await channelExists(ctx, stored))) throw new UserError(`Templates already live in <#${stored}>.`);
          const forumId = await ensureForum(ctx);
          await ctx.reply(`Templates now live in <#${forumId}>.`);
        },
      }),
    },
  });
}
