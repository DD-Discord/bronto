import {
  channelKeyOption,
  POST_CHANNEL_TYPES,
  TEXT_CHANNEL_TYPES,
  type ChannelRuleIndex,
  crudSubcommands,
  defineCommand,
  defineSubcommand,
  logChannel,
  opt,
  type CommandContext,
  type CommandDefinition,
} from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import type { AutodeleteConfig } from './config.js';
import { cooldowns, rules, type Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';

export type AutodeleteContext = CommandContext<AutodeleteConfig>;

export interface AutodeleteCommandDeps {
  index: ChannelRuleIndex<Rule>;
  log: ReturnType<typeof autodeleteLogChannel>;
}

/** The log-channel option of the autodelete command; created once per module and shared with its removal listener. */
export function autodeleteLogChannel() {
  return logChannel({
    table: rules,
    webhookName: (ctx) => (ctx.config as AutodeleteConfig).webhookName,
    channelTypes: POST_CHANNEL_TYPES,
    descriptions: { logChannel: 'Channel or thread for reports', removeLogChannel: 'Stop sending reports (edit only)' },
  });
}

export function createAutodeleteCommand(deps: AutodeleteCommandDeps): CommandDefinition {
  return defineCommand({
    description: 'Keeps one post per member in a channel and enforces a cooldown',
    permissions: PermissionFlagsBits.ManageMessages,
    subcommands: {
      ...crudSubcommands(ruleEntity, {
        key: channelKeyOption({ description: 'Channel of the rule', channelTypes: TEXT_CHANNEL_TYPES }),
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
          ...deps.log.fields,
        },
        descriptions: {
          create: 'Creates a rule for a channel',
          show: 'Shows the rule of a channel (default: this one)',
          delete: 'Deletes the rule of a channel and the cooldowns tracked for it',
        },
        hooks: {
          prepare: (ctx, values, existing) => deps.log.prepare(ctx, values, existing),
          afterWrite: async (ctx, record) => {
            deps.index.set(record);
            await deps.log.afterWrite(ctx, record);
          },
          beforeDelete: async (ctx, record) => {
            deps.index.delete(record.guildId, record.channelId);
            await deps.log.beforeDelete(ctx, record);
          },
        },
      }),
      reset: defineSubcommand({
        description: 'Resets the cooldown of a member',
        ephemeral: true,
        options: {
          user: opt.user({ description: 'The member', required: true }),
          channel: opt.channel({ description: 'Rule channel (default: all rule channels)', channelTypes: TEXT_CHANNEL_TYPES }),
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
