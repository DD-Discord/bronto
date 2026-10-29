import { channelKeyOption, POST_CHANNEL_TYPES, crudSubcommands, defineCommand, opt, UserError, type ChannelRuleIndex, type CommandDefinition } from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import type { Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';
import { parseEmojis } from './emojis.js';

export function createAutoreactCommand(deps: { index: ChannelRuleIndex<Rule> }): CommandDefinition {
  return defineCommand({
    description: 'Adds emoji reactions to every post in a channel',
    permissions: PermissionFlagsBits.ManageChannels,
    subcommands: crudSubcommands(ruleEntity, {
      style: 'set',
      key: channelKeyOption({ description: 'Channel or thread of the rule (default: this one)', channelTypes: POST_CHANNEL_TYPES }),
      fields: {
        // Parsed in `prepare`, which knows the server's emojis.
        emojis: { option: opt.string({ description: 'Up to 5 emojis, unicode or custom, in the order to add them' }) },
        'ignore-user': {
          option: opt.user({ description: 'Add a member whose posts get no reactions' }),
          // A null default keeps the option optional when `set` creates a rule; the value only reaches `prepare`.
          default: null as never,
        },
        'unignore-user': { option: opt.user({ description: 'Remove a member from the ignored members' }), default: null as never },
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
        list: 'Lists the autoreact rules of this server',
        remove: 'Removes the rule of a channel (default: this one)',
      },
      hooks: {
        prepare: (ctx, values, existing) => {
          const added = values['ignore-user'];
          const removed = values['unignore-user'];
          if (added !== null && removed !== null && added.id === removed.id) {
            throw new UserError('Use either `ignore-user` or `unignore-user` for a member, not both.');
          }
          const changes: { emojis?: string[]; ignoredUserIds?: string[] } = {};
          if (values.emojis !== null) changes.emojis = parseEmojis(values.emojis, (id) => ctx.client.emojis.cache.has(id));
          if (added !== null || removed !== null) {
            const ids = new Set(existing?.ignoredUserIds ?? []);
            if (added !== null) ids.add(added.id);
            if (removed !== null) ids.delete(removed.id);
            changes.ignoredUserIds = [...ids];
          }
          return changes;
        },
        afterWrite: (_ctx, record) => deps.index.set(record),
        beforeDelete: (_ctx, record) => deps.index.delete(record.guildId, record.channelId),
      },
    }),
  });
}
