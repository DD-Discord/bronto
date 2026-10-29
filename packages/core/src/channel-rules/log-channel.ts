import type { ChannelType, GuildBasedChannel } from 'discord.js';
import { and, eq, ne, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CrudField } from '../crud/subcommands.js';
import type { CommandContext } from '../interactions/context.js';
import { UserError } from '../interactions/errors.js';
import { opt } from '../interactions/options.js';
import type { HandlerContext } from '../runtime/types.js';
import { MissingWebhookPermissionError, UnknownWebhookError, withWebhookErrors } from '../webhooks/errors.js';
import { ensureWebhook } from '../webhooks/native.js';
import type { WebhookCredentials } from '../webhooks/types.js';
import type { ChannelRule } from './channel-rule-index.js';
import type { ChannelRuleTable } from './channel-rule-module.js';

/** A channel rule table with a log channel: the channel or thread reports go to, and the webhook that posts them. */
export type LogChannelTable = ChannelRuleTable & {
  logChannelId: PgColumn;
  /** Set when the log channel is a thread: reports go into it through its parent's webhook. */
  logThreadId: PgColumn;
  logWebhookId: PgColumn;
  /** Secret; never displayed or logged. */
  logWebhookToken: PgColumn;
};

export interface LogChannelColumns {
  logChannelId: string | null;
  logThreadId: string | null;
  logWebhookId: string | null;
  logWebhookToken: string | null;
}

/** The option values `prepare` reads; `channel` is the rule's own channel key. */
export interface LogChannelValues {
  channel?: GuildBasedChannel | null;
  'log-channel': GuildBasedChannel | null;
  'remove-log-channel': boolean | null;
}

export interface LogChannelOptions<TTable extends LogChannelTable> {
  table: TTable;
  /** Name of the webhooks created in log channels. */
  webhookName: (ctx: HandlerContext) => string;
  channelTypes: readonly ChannelType[];
  descriptions: { logChannel: string; removeLogChannel: string };
}

type LogRule<TTable extends LogChannelTable> = InferSelectModel<TTable> & LogChannelColumns & ChannelRule;

const LOG_COLUMNS_CLEARED: LogChannelColumns = { logChannelId: null, logThreadId: null, logWebhookId: null, logWebhookToken: null };

function credentialsOf(columns: { logWebhookId: string | null; logWebhookToken: string | null }): WebhookCredentials | null {
  return columns.logWebhookId === null || columns.logWebhookToken === null ? null : { id: columns.logWebhookId, token: columns.logWebhookToken };
}

/**
 * The `log-channel` and `remove-log-channel` fields of a channel rule's CRUD command and the hook steps that keep its
 * log webhook: `prepare` finds or creates the webhook, `afterWrite` and `beforeDelete` delete a webhook no other rule
 * of the server uses, and `onRemoved` does the same for `channelRuleListeners` without throwing. A module calls these
 * from its own hooks. Call once per command definition: it keeps the rule `prepare` saw per interaction.
 */
export function logChannel<TTable extends LogChannelTable>(options: LogChannelOptions<TTable>) {
  const { table } = options;
  // The rule a change replaces, kept from `prepare` to `afterWrite` to find a log webhook that is no longer used.
  const previous = new WeakMap<object, LogChannelColumns>();

  /** Deletes a log webhook unless another rule of this server still uses it. */
  async function deleteUnusedWebhook(ctx: HandlerContext, webhook: WebhookCredentials, ruleChannelId: string): Promise<void> {
    const shared = await ctx.db.run(async (tx) =>
      tx
        .select({ channelId: table.channelId })
        .from(table as PgTable)
        .where(and(eq(table.logWebhookId, webhook.id), ne(table.channelId, ruleChannelId)))
        .limit(1),
    );
    if (shared.length > 0) return;
    try {
      await withWebhookErrors(webhook.token, () => ctx.client.deleteWebhook(webhook.id, { token: webhook.token }));
    } catch (error) {
      if (!(error instanceof UnknownWebhookError)) throw error;
    }
  }

  const fields: { 'log-channel': CrudField<GuildBasedChannel>; 'remove-log-channel': CrudField<boolean> } = {
    'log-channel': {
      option: opt.channel({ description: options.descriptions.logChannel, channelTypes: options.channelTypes }),
      // A null default keeps the option optional when a rule is created; the value only reaches `prepare`.
      default: null as never,
    },
    'remove-log-channel': {
      option: opt.boolean({ description: options.descriptions.removeLogChannel }),
      default: false,
    },
  };

  return {
    fields,

    async prepare(
      ctx: CommandContext,
      values: LogChannelValues,
      existing: (InferSelectModel<TTable> & LogChannelColumns) | null,
    ): Promise<Partial<LogChannelColumns>> {
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
      const [sibling] = (await ctx.db.run(async (tx) =>
        tx
          .select({ logWebhookId: table.logWebhookId, logWebhookToken: table.logWebhookToken })
          .from(table as PgTable)
          .where(and(eq(table.logChannelId, target.id), ne(table.channelId, ruleChannelId ?? '')))
          .limit(1),
      )) as { logWebhookId: string | null; logWebhookToken: string | null }[];
      const known = (existing?.logChannelId === target.id ? credentialsOf(existing) : null) ?? (sibling === undefined ? null : credentialsOf(sibling));
      let webhook;
      try {
        webhook = await ensureWebhook(ctx.client, target.id, known, options.webhookName(ctx));
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

    async afterWrite(ctx: CommandContext, record: LogRule<TTable>): Promise<void> {
      const old = previous.get(ctx);
      const oldWebhook = old === undefined ? null : credentialsOf(old);
      if (oldWebhook === null || oldWebhook.id === record.logWebhookId) return;
      await deleteUnusedWebhook(ctx, oldWebhook, record.channelId);
    },

    async beforeDelete(ctx: CommandContext, record: LogRule<TTable>): Promise<void> {
      const webhook = credentialsOf(record);
      if (webhook === null) return;
      await deleteUnusedWebhook(ctx, webhook, record.channelId);
    },

    /** Deletes the log webhook of a rule removed with its channel unless another rule uses it; failures are logged. */
    async onRemoved(ctx: HandlerContext, rule: LogRule<TTable>): Promise<void> {
      const webhook = credentialsOf(rule);
      if (webhook === null) return;
      try {
        await deleteUnusedWebhook(ctx, webhook, rule.channelId);
      } catch (error) {
        ctx.log.warn({ err: error, channelId: rule.channelId }, 'Deleting the log webhook of a removed rule failed');
      }
    },
  };
}
