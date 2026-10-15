import { crudSubcommands, defineCommand, opt, UserError, type CommandDefinition } from '@bronto/core';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import { stickies, stickyState } from './db/schema.js';
import { MissingWebhookPermissionError, TemplateUnavailableError, type StickyDiscord } from './discord.js';
import { stickyEntity } from './entity.js';
import { parseMessageLink } from './message.js';
import { ignoreGone, targetOf, type Reposter, type StickyContext } from './repost.js';
import { entryOf, type StickyIndex } from './sticky-index.js';

const STICKY_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

const MAX_DEBOUNCE_MS = 86_400_000;

export interface StickyCommandDeps {
  index: StickyIndex;
  reposter: Reposter;
  discord: (ctx: StickyContext) => StickyDiscord;
}

/** Reads the template behind a message link; refuses links outside this server and messages with nothing to post. */
async function loadTemplate(ctx: StickyContext, discord: StickyDiscord, link: string) {
  const parsed = parseMessageLink(link);
  if (parsed === null) throw new UserError('The template must be a message link (right-click a message → Copy Message Link).');
  if (parsed.guildId !== ctx.guildId) throw new UserError('The template must be a message in this server.');
  let template;
  try {
    template = await discord.fetchTemplate(ctx.guildId, parsed.channelId, parsed.messageId);
  } catch (error) {
    if (error instanceof TemplateUnavailableError) throw new UserError(`I can't read that message: ${error.message}`);
    throw error;
  }
  if (template.content === '' && template.embeds.length === 0) throw new UserError('That message has no text or embeds to repeat.');
  return {
    templateChannelId: parsed.channelId,
    templateMessageId: parsed.messageId,
    content: template.content,
    embeds: template.embeds,
  };
}

export function createStickyCommand(deps: StickyCommandDeps): CommandDefinition {
  return defineCommand({
    name: 'sticky',
    description: 'Keeps a message at the bottom of a channel',
    permissions: PermissionFlagsBits.ManageMessages,
    subcommands: crudSubcommands(stickyEntity, {
      key: {
        name: 'channel',
        option: opt.channel({ description: 'Channel or thread of the sticky', channelTypes: STICKY_CHANNEL_TYPES }),
        toKey: (value) => value.id,
        format: (channelId) => `<#${channelId}>`,
        fallback: (ctx) => ctx.channelId,
      },
      fields: {
        template: { option: opt.string({ description: 'Link to the message to repeat' }) },
        'ignore-bots': { option: opt.boolean({ description: 'Ignore messages from bots (default: yes)' }), column: 'ignoreBots', default: true },
        silent: { option: opt.boolean({ description: 'Post without notifications (default: yes)' }), column: 'silent', default: true },
        debounce: {
          option: opt.integer({ description: 'Milliseconds of quiet before reposting (default: 0)', min: 0, max: MAX_DEBOUNCE_MS }),
          column: 'debounceMs',
          default: 0,
        },
      },
      descriptions: {
        create: 'Creates a sticky in a channel or thread',
        show: 'Shows the sticky of a channel (default: this one)',
        delete: 'Deletes the sticky of a channel (default: this one)',
      },
      hooks: {
        prepare: async (ctx, values, existing) => {
          const discord = deps.discord(ctx);
          const extra: Partial<typeof stickies.$inferInsert> = {};
          if (values.template !== null) Object.assign(extra, await loadTemplate(ctx, discord, values.template));
          if (existing === null) {
            const target = values.channel!;
            const webhookChannelId = target.isThread() ? target.parentId : target.id;
            if (webhookChannelId === null) throw new UserError('That thread has no parent channel I can post through.');
            let webhook;
            try {
              webhook = await discord.ensureWebhook(webhookChannelId, ctx.config.webhookName);
            } catch (error) {
              if (error instanceof MissingWebhookPermissionError) {
                throw new UserError(`I need the Manage Webhooks permission in <#${webhookChannelId}>.`);
              }
              throw error;
            }
            Object.assign(extra, {
              webhookId: webhook.id,
              webhookToken: webhook.token,
              parentChannelId: target.isThread() ? webhookChannelId : null,
            });
          }
          return extra;
        },
        afterWrite: (ctx, record) => {
          deps.index.set(entryOf(record));
          deps.reposter.cancel(record.channelId);
          void deps.reposter.queueRepost(ctx, record.channelId);
        },
        beforeDelete: async (ctx, record) => {
          deps.index.delete(record.channelId);
          deps.reposter.cancel(record.channelId);
          // Runs after any repost still in flight, so no post of this sticky is left behind.
          await ctx.queue.run(record.channelId, async (task) => {
            const discord = deps.discord(task);
            const target = targetOf(record);
            const [state] = await task.db.run(async (tx) =>
              tx.select().from(stickyState).where(eq(stickyState.channelId, record.channelId)),
            );
            if (state?.lastMessageId != null) await ignoreGone(discord.deleteMessage(target, state.lastMessageId));
            const shared = await task.db.run(async (tx) =>
              tx
                .select({ channelId: stickies.channelId })
                .from(stickies)
                .where(and(eq(stickies.webhookId, record.webhookId), ne(stickies.channelId, record.channelId)))
                .limit(1),
            );
            if (shared.length === 0) await discord.deleteWebhook(target);
          });
        },
      },
    }),
  });
}
