import {
  type ChannelRuleIndex,
  crudSubcommands,
  defineCommand,
  defineSubcommand,
  MissingWebhookPermissionError,
  ensureWebhook, withWebhookErrors, UnknownWebhookError,
  opt,
  UserError,
  type CommandContext,
  type CommandDefinition,
  type HandlerContext,
} from '@bronto/core';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { AutodeleteConfig } from './config.js';
import { cooldowns, rules, type Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';

export type AutodeleteContext = CommandContext<AutodeleteConfig>;

const RULE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const LOG_CHANNEL_TYPES = [...RULE_CHANNEL_TYPES, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];

export interface AutodeleteCommandDeps {
  index: ChannelRuleIndex<Rule>;
}

const LOG_COLUMNS_CLEARED = {
  logChannelId: null,
  logThreadId: null,
  logWebhookId: null,
  logWebhookToken: null,
} satisfies Partial<typeof rules.$inferInsert>;

/** Deletes a log webhook unless another rule of this server still uses it. */
async function deleteUnusedWebhook(
  ctx: HandlerContext<AutodeleteConfig>,
  webhook: { id: string; token: string },
  ruleChannelId: string,
): Promise<void> {
  const shared = await ctx.db.run(async (tx) =>
    tx
      .select({ channelId: rules.channelId })
      .from(rules)
      .where(and(eq(rules.logWebhookId, webhook.id), ne(rules.channelId, ruleChannelId)))
      .limit(1),
  );
  if (shared.length === 0) {
    try { await withWebhookErrors(webhook.token, () => ctx.client.deleteWebhook(webhook.id, { token: webhook.token })); }
    catch (error) { if (!(error instanceof UnknownWebhookError)) throw error; }
  }
}

/** Deletes the log webhook of a removed rule unless another rule uses it. */
export async function cleanUpRemovedRule(ctx: HandlerContext<AutodeleteConfig>, removed: Rule): Promise<void> {
  if (removed.logWebhookId === null || removed.logWebhookToken === null) return;
  try {
    await deleteUnusedWebhook(ctx, { id: removed.logWebhookId, token: removed.logWebhookToken }, removed.channelId);
  } catch (error) {
    ctx.log.warn({ err: error, channelId: removed.channelId }, 'Deleting the log webhook of a removed rule failed');
  }
}

export function createAutodeleteCommand(deps: AutodeleteCommandDeps): CommandDefinition {
  // The rule an edit replaces, kept from `prepare` to `afterWrite` to find a log webhook that is no longer used.
  const previous = new WeakMap<object, Rule>();

  return defineCommand({
    description: 'Keeps one post per member in a channel and enforces a cooldown',
    permissions: PermissionFlagsBits.ManageMessages,
    subcommands: {
      ...crudSubcommands(ruleEntity, {
        key: {
          name: 'channel',
          option: opt.channel({ description: 'Channel of the rule', channelTypes: RULE_CHANNEL_TYPES }),
          toKey: (value) => value.id,
          format: (channelId) => `<#${channelId}>`,
          fallback: (ctx) => ctx.channelId,
        },
        fields: {
          enabled: { option: opt.boolean({ description: 'Apply the rule (default: yes)' }), column: 'enabled', default: true },
          'keep-latest': {
            option: opt.boolean({ description: 'Remove a member\'s older post when they post again (default: yes)' }),
            column: 'keepLatest',
            default: true,
          },
          'delete-on-leave': {
            option: opt.boolean({ description: 'Remove a member\'s posts when they leave (default: no)' }),
            column: 'deleteOnLeave',
            default: false,
          },
          cooldown: {
            option: opt.duration({ description: 'Time before a member may post again, e.g. 14d (default: 0s, off)' }),
            column: 'cooldownMs',
            default: 0,
          },
          grace: {
            option: opt.duration({ description: 'Deleting a post within this time resets the cooldown, e.g. 1h (default: 0s, off)' }),
            column: 'graceMs',
            default: 0,
          },
          'notify-dm': {
            option: opt.boolean({ description: 'Send members a copy of a removed post (default: no)' }),
            column: 'notifyDm',
            default: false,
          },
          'log-channel': {
            option: opt.channel({ description: 'Channel or thread for reports', channelTypes: LOG_CHANNEL_TYPES }),
            // A null default keeps the option optional in `create`; the value only reaches `prepare`.
            default: null as never,
          },
          'remove-log-channel': {
            option: opt.boolean({ description: 'Stop sending reports (edit only)' }),
            default: false,
          },
        },
        descriptions: {
          create: 'Creates a rule for a channel',
          show: 'Shows the rule of a channel (default: this one)',
          delete: 'Deletes the rule of a channel and the cooldowns tracked for it',
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

            const parentId = target.isThread() ? target.parentId : target.id;
            if (parentId === null) throw new UserError('That thread has no parent channel I can post through.');
            // Only the webhook of another rule is reused: its ID is stored here, so it is known to be ours.
            const [sibling] = await ctx.db.run(async (tx) =>
              tx
                .select({ id: rules.logWebhookId, token: rules.logWebhookToken })
                .from(rules)
                .where(and(eq(rules.logChannelId, target.id), ne(rules.channelId, values.channel?.id ?? '')))
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
              if (error instanceof MissingWebhookPermissionError) {
                throw new UserError(`I need the Manage Webhooks permission in <#${parentId}>.`);
              }
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
      reset: defineSubcommand({
        description: 'Resets the cooldown of a member',
        ephemeral: true,
        options: {
          user: opt.user({ description: 'The member', required: true }),
          channel: opt.channel({ description: 'Rule channel (default: all rule channels)', channelTypes: RULE_CHANNEL_TYPES }),
        },
        execute: async (ctx, { user, channel }) => {
          const removed = await ctx.db.run(async (tx) =>
            tx
              .delete(cooldowns)
              .where(channel === null ? eq(cooldowns.userId, user.id) : and(eq(cooldowns.userId, user.id), eq(cooldowns.channelId, channel.id)))
              .returning({ channelId: cooldowns.channelId }),
          );
          if (removed.length === 0) {
            await ctx.reply(`<@${user.id}> has no cooldown here.`);
          } else if (channel !== null) {
            await ctx.reply(`Cooldown reset for <@${user.id}> in <#${channel.id}>.`);
          } else {
            await ctx.reply(`Cooldown reset for <@${user.id}> in ${removed.length} ${removed.length === 1 ? 'channel' : 'channels'}.`);
          }
        },
      }),
    },
  });
}
