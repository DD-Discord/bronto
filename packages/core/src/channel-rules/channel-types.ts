import { ChannelType } from 'discord.js';

/** Text and announcement channels. */
export const TEXT_CHANNEL_TYPES: readonly ChannelType[] = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export const THREAD_CHANNEL_TYPES: readonly ChannelType[] = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

/** Channels that hold posts of their own: text and announcement channels and threads. */
export const POST_CHANNEL_TYPES: readonly ChannelType[] = [...TEXT_CHANNEL_TYPES, ...THREAD_CHANNEL_TYPES];
