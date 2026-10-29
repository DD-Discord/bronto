import { ChannelType, type GuildBasedChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../interactions/context.js';
import { channelKeyOption } from './keys.js';

describe('channelKeyOption', () => {
  const key = channelKeyOption({ description: 'Channel of the rule', channelTypes: [ChannelType.GuildText] });

  it('names the option channel and passes the types through', () => {
    expect(key.name).toBe('channel');
    expect(key.option.channelTypes).toEqual([ChannelType.GuildText]);
    expect(key.option.description).toBe('Channel of the rule');
  });

  it('keys by channel ID and formats a mention', () => {
    expect(key.toKey({ id: '1' } as GuildBasedChannel)).toBe('1');
    expect(key.format?.('1')).toBe('<#1>');
  });

  it('falls back to the current channel', () => {
    expect(key.fallback?.({ channelId: '2' } as CommandContext)).toBe('2');
  });
});
