import { defineCommand, defineSubcommand, opt, recordList, UserError, type CommandDefinition } from '@bronto/core';
import { suggestTemplates } from '@bronto/templates';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { FormsContext } from './context.js';
import { forms } from './db/schema.js';
import { formForum } from './lifecycle.js';
import { buttonsMessage, postOpener, suggestForms } from './post.js';

const OPENER_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];
/** The reply of `/forms list`: one line per form with its state and a link, cut to fit a message. */
async function listReply(ctx: FormsContext): Promise<string> {
  const rows = await ctx.db.run(async (tx) =>
    tx.select({ name: forms.name, threadId: forms.threadId, active: forms.active }).from(forms),
  );
  if (rows.length === 0) {
    const forumId = await formForum.storedId(ctx);
    return forumId === null
      ? 'No forms yet. Run /forms init to create the forms forum.'
      : `No forms yet. Create a post in <#${forumId}>.`;
  }
  return recordList({
    guildId: ctx.guildId,
    rows: rows.map((row) => ({ name: row.name, threadId: row.threadId, suffix: row.active ? 'active' : 'inactive' })),
  });
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
          const stored = await formForum.storedId(ctx);
          if (stored !== null && (await formForum.channelExists(ctx, stored))) throw new UserError(`Forms already live in <#${stored}>.`);
          const forumId = await formForum.ensure(ctx);
          await ctx.reply(`Forms now live in <#${forumId}>.`);
        },
      }),
    },
  });
}
