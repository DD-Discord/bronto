import { UserError } from '@bronto/core';
import type { GuildTextBasedChannel, Message } from 'discord.js';
import { MAX_MESSAGES } from './limits.js';

export interface MessageLink {
  guildId: string;
  channelId: string;
  messageId: string;
}

const LINK = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})$/;

/** Reads a link to a message in a server; direct-message links and other hosts give null. */
export function parseMessageLink(link: string): MessageLink | null {
  const match = LINK.exec(link.trim());
  return match === null ? null : { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}

const PAGE = 100;

/**
 * The messages from `fromId` to `toId` (or just `fromId`) of the channel, oldest first and inclusive. The ends may
 * be given in either order. Throws a `UserError` when an end doesn't exist or the range holds more than
 * `MAX_MESSAGES` messages; reading stops as soon as the cap is exceeded.
 */
export async function readRange(channel: GuildTextBasedChannel, fromId: string, toId: string | null): Promise<Message[]> {
  const first = BigInt(fromId);
  const second = toId === null ? first : BigInt(toId);
  const [low, high] = first <= second ? [first, second] : [second, first];
  const messages: Message[] = [];
  let cursor = low - 1n;
  let done = false;
  while (!done) {
    const page = [...(await channel.messages.fetch({ after: String(cursor), limit: PAGE })).values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (page.length === 0) break;
    for (const message of page) {
      if (BigInt(message.id) > high) {
        done = true;
        break;
      }
      messages.push(message);
      if (messages.length > MAX_MESSAGES) {
        throw new UserError(`That range has more than ${MAX_MESSAGES} messages; move at most ${MAX_MESSAGES} at a time.`);
      }
    }
    cursor = BigInt(page[page.length - 1]!.id);
    if (page.length < PAGE) done = true;
  }
  if (messages[0]?.id !== String(low) || messages[messages.length - 1]?.id !== String(high)) throw new UserError("That message doesn't exist.");
  return messages;
}
