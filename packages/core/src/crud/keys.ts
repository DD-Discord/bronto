import type { ChannelType, GuildBasedChannel } from 'discord.js';
import { opt } from '../interactions/options.js';
import type { CrudKey } from './subcommands.js';

/** The `channel` key of a rule keyed by channel ID; `show` falls back to the current channel. */
export function channelKeyOption(input: { description: string; channelTypes: readonly ChannelType[] }): CrudKey<'channel', GuildBasedChannel> {
  return {
    name: 'channel',
    option: opt.channel(input),
    toKey: (channel) => channel.id,
    format: (channelId) => `<#${channelId}>`,
    fallback: (ctx) => ctx.channelId,
  };
}
