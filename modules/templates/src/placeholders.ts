import type { Message } from 'discord.js';

const PLACEHOLDER = /\{([a-z]+(?:\.[a-z]+)*)\}/g;

/** Replaces each `{key}` that `values` knows; unknown keys stay as written, and replaced text is not scanned again. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match));
}

/** The placeholder values of a message: its author, channel, server and link. */
export function postPlaceholders(message: Message): Record<string, string> {
  const { author, member } = message;
  return {
    'user.mention': `<@${author.id}>`,
    'user.name': author.username,
    'user.display': member?.displayName ?? author.displayName,
    'channel.mention': `<#${message.channelId}>`,
    'server.name': message.guild?.name ?? '',
    'message.link': message.url,
  };
}
