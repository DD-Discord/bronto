import type { Message } from 'discord.js';

const PLACEHOLDER = /\{([a-z]+(?:\.[a-z]+)*)\}/g;

/** Placeholders filled with Discord timestamps: they render in each reader's time zone, but only in message text. */
const TIMESTAMP_STYLES = { date: 'D', 'date.short': 'd', time: 't', datetime: 'f', 'date.relative': 'R' } as const;
export const TIMESTAMP_PLACEHOLDERS = Object.keys(TIMESTAMP_STYLES);

/** Replaces each `{key}` that `values` knows; unknown keys stay as written, and replaced text is not scanned again. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match));
}

/** The placeholder values of a message: its author, channel, server, link and when it was posted. */
export function postPlaceholders(message: Message): Record<string, string> {
  const { author, member, channel } = message;
  const unix = Math.floor(message.createdTimestamp / 1000);
  const timestamps = Object.fromEntries(Object.entries(TIMESTAMP_STYLES).map(([key, style]) => [key, `<t:${unix}:${style}>`]));
  return {
    'user.mention': `<@${author.id}>`,
    'user.name': author.username,
    'user.display': member?.displayName ?? author.displayName,
    'channel.mention': `<#${message.channelId}>`,
    'channel.name': channel !== null && 'name' in channel && typeof channel.name === 'string' ? channel.name : '',
    'server.name': message.guild?.name ?? '',
    'message.link': message.url,
    ...timestamps,
    // UTC: plain text has no reader whose time zone it could follow.
    'date.iso': new Date(message.createdTimestamp).toISOString().slice(0, 10),
  };
}
