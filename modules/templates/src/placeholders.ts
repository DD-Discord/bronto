import type { GuildMember, Message, User } from 'discord.js';

const PLACEHOLDER = /\{([a-z]+(?:\.[a-z]+)*)\}/g;

/** Placeholders filled with Discord timestamps: they render in each reader's time zone, but only in message text. */
const TIMESTAMP_STYLES = { date: 'D', 'date.short': 'd', time: 't', datetime: 'f', 'date.relative': 'R' } as const;
export const TIMESTAMP_PLACEHOLDERS = Object.keys(TIMESTAMP_STYLES);

/** Replaces each `{key}` that `values` knows; unknown keys stay as written, and replaced text is not scanned again. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match));
}

/** A member's name is their nickname; a user's is their global name. */
function whoIs(author: GuildMember | User): { id: string; user: User; display: string } {
  return { id: author.id, user: 'user' in author ? author.user : author, display: author.displayName };
}

/** The placeholder values of a message: its author (or `author`, when given), channel, server, link and when it was posted. */
export function postPlaceholders(message: Message, author?: GuildMember | User): Record<string, string> {
  const { channel } = message;
  const who = author === undefined ? { id: message.author.id, user: message.author, display: message.member?.displayName ?? message.author.displayName } : whoIs(author);
  const unix = Math.floor(message.createdTimestamp / 1000);
  const timestamps = Object.fromEntries(Object.entries(TIMESTAMP_STYLES).map(([key, style]) => [key, `<t:${unix}:${style}>`]));
  return {
    'user.mention': `<@${who.id}>`,
    'user.name': who.user.username,
    'user.display': who.display,
    'channel.mention': `<#${message.channelId}>`,
    'channel.name': channel !== null && 'name' in channel && typeof channel.name === 'string' ? channel.name : '',
    'server.name': message.guild?.name ?? '',
    'message.link': message.url,
    ...timestamps,
    // UTC: plain text has no reader whose time zone it could follow.
    'date.iso': new Date(message.createdTimestamp).toISOString().slice(0, 10),
  };
}
