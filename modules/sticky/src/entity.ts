import { defineEntity, formatDuration, truncate } from '@bronto/core';
import { stickies } from './db/schema.js';

export const stickyEntity = defineEntity({
  table: stickies,
  key: 'channelId',
  displayName: { singular: 'Sticky', plural: 'Stickies' },
  formatShort: (sticky) => `<#${sticky.channelId}>`,
  formatFull: (sticky, base) =>
    base().addFields(
      {
        name: 'Template',
        value: `https://discord.com/channels/${sticky.guildId}/${sticky.templateChannelId}/${sticky.templateMessageId}`,
      },
      { name: 'Ignore bots', value: sticky.ignoreBots ? 'Yes' : 'No', inline: true },
      { name: 'Silent', value: sticky.silent ? 'Yes' : 'No', inline: true },
      { name: 'Debounce', value: sticky.debounceMs === 0 ? 'Off' : formatDuration(sticky.debounceMs), inline: true },
      { name: 'Text', value: sticky.content === '' ? '(embeds only)' : truncate(sticky.content, 1024) },
    ),
});
