import {
  channelKeyOption,
  POST_CHANNEL_TYPES,
  crudSubcommands,
  defineCommand,
  logChannel,
  opt,
  type CommandDefinition,
} from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import type { MediaonlyConfig } from './config.js';
import { rules, type Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';
import type { RuleIndex } from './rule-index.js';

/** The log-channel option of the mediaonly command; created once per module and shared with its removal listener. */
export function mediaonlyLogChannel() {
  return logChannel({
    table: rules,
    webhookName: (ctx) => (ctx.config as MediaonlyConfig).webhookName,
    channelTypes: POST_CHANNEL_TYPES,
    descriptions: { logChannel: 'Channel or thread for reports', removeLogChannel: 'Stop sending reports' },
  });
}

export function createMediaonlyCommand(deps: { index: RuleIndex; log: ReturnType<typeof mediaonlyLogChannel> }): CommandDefinition {
  return defineCommand({
    description: 'Removes posts without an attachment or link',
    permissions: PermissionFlagsBits.ManageChannels,
    subcommands: crudSubcommands(ruleEntity, {
      style: 'set',
      key: channelKeyOption({ description: 'Channel or thread of the rule (default: this one)', channelTypes: POST_CHANNEL_TYPES }),
      fields: {
        'require-spoiler': {
          option: opt.boolean({ description: 'Every attachment and link must be marked spoiler (default: no)' }),
          column: 'requireSpoiler',
          default: false,
        },
        ...deps.log.fields,
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
  });
}
