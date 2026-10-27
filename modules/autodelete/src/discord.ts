import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';

export interface FetchedPost { content: string; attachmentCount: number; }
export type DeleteOutcome = 'deleted' | 'gone' | 'forbidden';
const isGone = (error: unknown) => error instanceof DiscordAPIError &&
  (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel);

/** Reads current text for reports without retaining the message in the cache. */
export async function fetchPost(client: Client, channelId: string, messageId: string): Promise<FetchedPost | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    return { content: message.content, attachmentCount: message.attachments.size };
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

export { deleteMessage as deletePost, sendDm } from '@bronto/core';
