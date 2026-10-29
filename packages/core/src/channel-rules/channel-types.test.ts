import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { POST_CHANNEL_TYPES, TEXT_CHANNEL_TYPES, THREAD_CHANNEL_TYPES } from './channel-types.js';

describe('channel type sets', () => {
  it('lists text and announcement channels', () => {
    expect(TEXT_CHANNEL_TYPES).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  });

  it('lists the thread types', () => {
    expect(THREAD_CHANNEL_TYPES).toEqual([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
  });

  it('combines both for post channels', () => {
    expect(POST_CHANNEL_TYPES).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ]);
  });
});
