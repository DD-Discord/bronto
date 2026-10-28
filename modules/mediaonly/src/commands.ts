import {
  crudSubcommands,
  defineCommand,
  ensureWebhook,
  MissingWebhookPermissionError,
  opt,
  UnknownWebhookError,
  UserError,
  withWebhookErrors,
  type CommandDefinition,
  type HandlerContext,
} from '@bronto/core';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { MediaonlyConfig } from './config.js';
import { rules, type Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';
import type { RuleIndex } from './rule-index.js';

type MediaonlyContext = HandlerContext<MediaonlyConfig>;

/** Text and announcement channels and threads; forum and media channels have no posts of their own. */
const CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

const LOG_COLUMNS_CLEARED = {
  logChannelId: null,
  logThreadId: null,
  logWebhookId: null,
  logWebhookToken: null,
} satisfies Partial<typeof rules.$inferInsert>;

/** Deletes a log webhook unless another rule of this server still uses it. */
async function deleteUnusedWebhook(ctx: MediaonlyContext, webhook: { id: string; token: string }, ruleChannelId: string): Promise<void> {
  const shared = await ctx.db.run(async (tx) =>
    tx
      .select({ channelId: rules.channelId })
      .from(rules)
      .where(and(eq(rules.logWebhookId, webhook.id), ne(rules.channelId, ruleChannelId)))
      .limit(1),
  );
  if (shared.length > 0) return;
  try {
    await withWebhookErrors(webhook.token, () => ctx.client.deleteWebhook(webhook.id, { token: webhook.token }));
  } catch (error) {
    if (!(error instanceof UnknownWebhookError)) throw error;
  }
}

/** Deletes the log webhook of a removed rule unless another rule uses it. */
export async function cleanUpRemovedRule(ctx: MediaonlyContext, removed: Rule): Promise<void> {
  if (removed.logWebhookId === null || removed.logWebhookToken === null) return;
  try {
    await deleteUnusedWebhook(ctx, { id: removed.logWebhookId, token: removed.logWebhookToken }, removed.channelId);
  } catch (error) {
    ctx.log.warn({ err: error, channelId: removed.channelId }, 'Deleting the log webhook of a removed rule failed');
  }
}

export function createMediaonlyCommand(deps: { index: RuleIndex }): CommandDefinition {
  // The rule a change replaces, kept from `prepare` to `afterWrite` to find a log webhook that is no longer used.
  const previous = new WeakMap<object, Rule>();

  return defineCommand({
    description: 'Removes posts without an attachment or link',
    permissions: PermissionFlagsBits.ManageChannels,
    subcommands: crudSubcommands(ruleEntity, {
      style: 'set',
      key: {
        name: 'channel',
        option: opt.channel({ description: 'Channel or thread of the rule (default: this one)', channelTypes: CHANNEL_TYPES }),
        toKey: (value) => value.id,
        format: (channelId) => `<#${channelId}>`,
        fallback: (ctx) => ctx.channelId,
      },
      fields: {
        'require-spoiler': {
          option: opt.boolean({ description: 'Every attachment and link must be marked spoiler (default: no)' }),
          column: 'requireSpoiler',
          default: false,
        },
        'log-channel': {
          option: opt.channel({ description: 'Channel or thread for reports', channelTypes: CHANNEL_TYPES }),
          // A null default keeps the option optional when `set` creates a rule; the value only reaches `prepare`.
          default: null as never,
        },
        'remove-log-channel': {
          option: opt.boolean({ description: 'Stop sending reports' }),
          default: false,
        },
        enabled: { option: opt.boolean({ description: 'Apply the rule (default: yes)' }), column: 'enabled', default: true },
        'ignore-bots': {
          option: opt.boolean({ description: 'Leave posts of bots and webhooks alone (default: yes)' }),
          column: 'ignoreBots',
          default: true,
        },
      },
      descriptions: {
        set: 'Creates or changes the rule of a channel (default: this one)',
        show: 'Shows the rule of a channel (default: this one)',
        list: 'Lists the media-only rules of this server',
        remove: 'Removes the rule of a channel (default: this one)',
      },
      hooks: {
        prepare: async (ctx, values, existing) => {
          if (existing !== null) previous.set(ctx, existing);
          const target = values['log-channel'];
          if (values['remove-log-channel'] === true) {
            if (target !== null) throw new UserError('Use either `log-channel` or `remove-log-channel`, not both.');
            return existing === null ? {} : LOG_COLUMNS_CLEARED;
          }
          if (target === null) return {};

          const ruleChannelId = values.channel?.id ?? ctx.channelId;
          const parentId = target.isThread() ? target.parentId : target.id;
          if (parentId === null) throw new UserError('That thread has no parent channel I can post through.');
          // Only the webhook of another rule is reused: its ID is stored here, so it is known to be ours.
          const [sibling] = await ctx.db.run(async (tx) =>
            tx
              .select({ id: rules.logWebhookId, token: rules.logWebhookToken })
              .from(rules)
              .where(and(eq(rules.logChannelId, target.id), ne(rules.channelId, ruleChannelId ?? '')))
              .limit(1),
          );
          const known =
            existing?.logChannelId === target.id && existing.logWebhookId !== null && existing.logWebhookToken !== null
              ? { id: existing.logWebhookId, token: existing.logWebhookToken }
              : sibling?.id != null && sibling.token != null
                ? { id: sibling.id, token: sibling.token }
                : null;
          let webhook;
          try {
            webhook = await ensureWebhook(ctx.client, target.id, known, ctx.config.webhookName);
          } catch (error) {
            if (error instanceof MissingWebhookPermissionError) throw new UserError(`I need the Manage Webhooks permission in <#${parentId}>.`);
            throw error;
          }
          return {
            logChannelId: target.id,
            logThreadId: webhook.threadId,
            logWebhookId: webhook.webhook.id,
            logWebhookToken: webhook.webhook.token,
          };
        },
        afterWrite: async (ctx, record) => {
          deps.index.set(record);
          const old = previous.get(ctx);
          if (old?.logWebhookId == null || old.logWebhookToken == null || old.logWebhookId === record.logWebhookId) return;
          await deleteUnusedWebhook(ctx, { id: old.logWebhookId, token: old.logWebhookToken }, record.channelId);
        },
        beforeDelete: async (ctx, record) => {
          deps.index.delete(record.guildId, record.channelId);
          if (record.logWebhookId === null || record.logWebhookToken === null) return;
          await deleteUnusedWebhook(ctx, { id: record.logWebhookId, token: record.logWebhookToken }, record.channelId);
        },
      },
    }),
  });
}
