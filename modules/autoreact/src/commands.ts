import { crudSubcommands, defineCommand, opt, UserError, type CommandDefinition, type HandlerContext } from '@bronto/core';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { eq } from 'drizzle-orm';
import { rules } from './db/schema.js';
import { ruleEntity } from './entity.js';
import { parseEmojis } from './emojis.js';
import type { RuleIndex } from './rule-index.js';

/** Text and announcement channels and threads; forum and media channels have no posts of their own. */
const CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

/** Deletes the rule of a deleted channel or thread. */
export async function removeRuleOf(ctx: HandlerContext, index: RuleIndex, channelId: string): Promise<void> {
  const [removed] = await ctx.db.run(async (tx) => tx.delete(rules).where(eq(rules.channelId, channelId)).returning());
  if (removed !== undefined) index.delete(removed.guildId, removed.channelId);
}

export function createAutoreactCommand(deps: { index: RuleIndex }): CommandDefinition {
  return defineCommand({
    description: 'Adds emoji reactions to every post in a channel',
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
