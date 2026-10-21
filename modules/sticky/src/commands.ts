import {
  batchLines,
  crudSubcommands,
  defineCommand,
  defineSubcommand,
  opt,
  UserError,
  ensureWebhook,
  withWebhookErrors,
  UnknownWebhookError,
  MissingWebhookPermissionError,
  type Autocomplete,
  type CommandDefinition,
  type HandlerContext,
} from '@bronto/core';
import templates from '@bronto/templates';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import { stickies, stickyState } from './db/schema.js';
import { stickyEntity, templateField } from './entity.js';
import { removePost, type Reposter } from './repost.js';
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
}

const channelOption = () => opt.channel({ description: 'Channel or thread of the sticky', channelTypes: STICKY_CHANNEL_TYPES });

/** Templates whose name contains the query, as `name · created date` (UTC). */
const suggestTemplates: Autocomplete = async (ctx, query) =>
  (await ctx.modules.get(templates).search(query)).map((template) => ({
    name: `${template.name} · ${template.createdAt.toISOString().slice(0, 10)}`,
    value: template.id,
  }));

/** Name and post link of a sticky's template, or null when it no longer exists. */
const templateOf = (ctx: HandlerContext, templateId: string) => ctx.modules.get(templates).get(templateId);

export function createStickyCommand(deps: StickyCommandDeps): CommandDefinition {
  return defineCommand({
    description: 'Keeps a message at the bottom of a channel',
    permissions: PermissionFlagsBits.ManageMessages,
    subcommands: crudSubcommands(stickyEntity, {
      key: {
        name: 'channel',
        option: channelOption(),
        toKey: (value) => value.id,
        format: (channelId) => `<#${channelId}>`,
        fallback: (ctx) => ctx.channelId,
      },
      fields: {
        template: { option: opt.string({ description: 'Template to post', autocomplete: suggestTemplates }), column: 'templateId' },
        'ignore-bots': { option: opt.boolean({ description: 'Ignore messages from bots (default: yes)' }), column: 'ignoreBots', default: true },
        silent: { option: opt.boolean({ description: 'Post without notifications (default: yes)' }), column: 'silent', default: true },
        debounce: {
          option: opt.duration({ description: 'Quiet time before reposting, e.g. 30s (default: 0s)', max: MAX_DEBOUNCE_MS }),
          column: 'debounceMs',
          default: 0,
        },
      },
      descriptions: {
        create: 'Creates a sticky in a channel or thread',
        delete: 'Deletes the sticky of a channel (default: this one)',
      },
      override: {
        show: defineSubcommand({
          description: 'Shows the sticky of a channel (default: this one)',
          ephemeral: true,
          options: { channel: channelOption() },
          execute: async (ctx, { channel }) => {
            const channelId = channel?.id ?? ctx.channelId;
            if (channelId === null) throw new UserError('Name the sticky with the `channel` option.');
            const sticky = await stickyEntity.find(ctx.db, channelId);
            if (sticky === null) throw new UserError(`There is no sticky for <#${channelId}>.`);
            const embed = stickyEntity.formatFull(sticky);
            embed.spliceFields(0, 1, { name: 'Template', value: templateField(sticky, await templateOf(ctx, sticky.templateId)) });
            await ctx.reply({ embeds: [embed] });
          },
        }),
        list: defineSubcommand({
          description: 'Lists all stickies',
          ephemeral: true,
          execute: async (ctx) => {
            const records = await stickyEntity.list(ctx.db);
            if (records.length === 0) {
              await ctx.reply('There are no stickies yet.');
              return;
            }
            const lines = [`**${records.length} ${records.length === 1 ? 'Sticky' : 'Stickies'}**`];
            for (const sticky of records) {
              const template = await templateOf(ctx, sticky.templateId);
              lines.push(`- <#${sticky.channelId}> · ${template === null ? 'missing template' : templateField(sticky, template)}`);
            }
            for (const chunk of batchLines(lines)) await ctx.reply(chunk);
          },
        }),
      },
      hooks: {
        prepare: async (ctx, values, existing) => {
          const extra: Partial<typeof stickies.$inferInsert> = {};
          if (values.template !== null) {
            if ((await templateOf(ctx, values.template)) === null) throw new UserError("That template doesn't exist.");
            // A copy stored before templates no longer describes what the sticky posts.
            Object.assign(extra, { content: null, embeds: null });
          }
          if (existing === null) {
            const target = values.channel!;
            const webhookChannelId = target.isThread() ? target.parentId : target.id;
            if (webhookChannelId === null) throw new UserError('That thread has no parent channel I can post through.');
            // Only a webhook of another sticky is reused: its ID is stored here, so it is known to be ours.
            const [sibling] = await ctx.db.run(async (tx) =>
              tx
                .select({ id: stickies.webhookId, token: stickies.webhookToken })
                .from(stickies)
                .where(sql`coalesce(${stickies.parentChannelId}, ${stickies.channelId}) = ${webhookChannelId}`)
                .limit(1),
            );
            let webhook;
            try {
              webhook = (await ensureWebhook(ctx.client, target.id, sibling ?? null, ctx.config.webhookName)).webhook;
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
            const [current, state] = await task.db.run(async (tx) => {
              const [row] = await tx.select().from(stickies).where(eq(stickies.channelId, record.channelId));
              const [last] = await tx.select().from(stickyState).where(eq(stickyState.channelId, record.channelId));
              return [row, last] as const;
            });
            // A repost that ran meanwhile may have replaced the webhook the command loaded.
            const sticky = current ?? record;
            if (state?.lastMessageId != null) {
              try {
                await removePost(task, sticky, state.lastMessageId);
              } catch (error) {
                task.log.warn({ err: error, channelId: record.channelId }, 'Deleting the sticky post failed');
              }
            }
            const shared = await task.db.run(async (tx) =>
              tx
                .select({ channelId: stickies.channelId })
                .from(stickies)
                .where(and(eq(stickies.webhookId, sticky.webhookId), ne(stickies.channelId, record.channelId)))
                .limit(1),
            );
            if (shared.length === 0) {
              try {
                await withWebhookErrors(sticky.webhookToken, () => task.client.deleteWebhook(sticky.webhookId, { token: sticky.webhookToken }));
              } catch (error) {
                if (!(error instanceof UnknownWebhookError)) throw error;
              }
            }
          });
        },
      },
    }),
  });
}
