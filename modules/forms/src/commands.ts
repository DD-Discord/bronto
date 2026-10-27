import { defineCommand, defineSubcommand, opt, UserError, type CommandDefinition } from '@bronto/core';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { FormsContext } from './context.js';
import { forms } from './db/schema.js';
import { channelExists, ensureForum, storedForumId } from './forum.js';
import { buttonsMessage, postOpener, suggestForms, suggestTemplates } from './post.js';

const MAX_LISTED = 50;
const OPENER_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];
// Discord's limit for message content.
const MAX_CONTENT = 2000;

/** Escapes the characters that would end a Markdown link's text or target early, e.g. in a form name. */
function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]()]/g, '\\$&');
}

const moreLine = (count: number) => `…and ${count} more`;

/** The reply of `/forms list`: one line per form with its state and a link, cut to fit a message. */
async function listReply(ctx: FormsContext): Promise<string> {
  const rows = await ctx.db.run(async (tx) =>
    tx.select({ name: forms.name, threadId: forms.threadId, active: forms.active }).from(forms),
  );
  if (rows.length === 0) {
    const forumId = await storedForumId(ctx);
    return forumId === null
      ? 'No forms yet. Run /forms init to create the forms forum.'
      : `No forms yet. Create a post in <#${forumId}>.`;
  }
  rows.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const lines: string[] = [];
  for (const row of rows.slice(0, MAX_LISTED)) {
    const line = `[${escapeLinkText(row.name)}](https://discord.com/channels/${ctx.guildId}/${row.threadId}) · ${row.active ? 'active' : 'inactive'}`;
    const rest = rows.length - lines.length - 1;
    const text = [...lines, line].join('\n') + (rest > 0 ? `\n${moreLine(rest)}` : '');
    if (text.length > MAX_CONTENT) break;
    lines.push(line);
  }
  if (lines.length < rows.length) lines.push(moreLine(rows.length - lines.length));
  return lines.join('\n');
}

export function createFormsCommand(): CommandDefinition {
  return defineCommand({
    description: 'Manages forms',
    permissions: PermissionFlagsBits.Administrator,
    subcommands: {
      list: defineSubcommand({
        description: 'Lists the forms with links to their posts',
        ephemeral: true,
        execute: async (ctx) => {
          await ctx.reply(await listReply(ctx));
        },
      }),
      post: defineSubcommand({
        description: 'Posts a button that opens a form',
        ephemeral: true,
        options: {
          channel: opt.channel({ description: 'Where the button goes', required: true, channelTypes: OPENER_CHANNEL_TYPES }),
          form: opt.string({ description: 'The form to open', required: true, autocomplete: suggestForms }),
          label: opt.string({ description: 'Button text (default: the form name)', maxLength: 80 }),
          template: opt.string({ description: 'Template to post with the button', autocomplete: suggestTemplates }),
          message: opt.string({ description: 'Link to an earlier message with form buttons to add the button to' }),
        },
        execute: async (ctx, options) => {
          await ctx.reply(await postOpener(ctx, options));
        },
      }),
      buttons: defineSubcommand({
        description: 'Lists the form buttons of a channel and removes them',
        ephemeral: true,
        options: { channel: opt.channel({ description: 'The channel to look at', required: true, channelTypes: OPENER_CHANNEL_TYPES }) },
        execute: async (ctx, { channel }) => {
          await ctx.reply(await buttonsMessage(ctx, channel.id));
        },
      }),
      init: defineSubcommand({
        description: 'Creates the forum that holds the forms',
        execute: async (ctx) => {
          const stored = await storedForumId(ctx);
          if (stored !== null && (await channelExists(ctx, stored))) throw new UserError(`Forms already live in <#${stored}>.`);
          const forumId = await ensureForum(ctx);
          await ctx.reply(`Forms now live in <#${forumId}>.`);
        },
      }),
    },
  });
}
