import { stripRequestBody, type WebhookMessage } from '@bronto/core';
import { DiscordAPIError, RESTJSONErrorCodes, type Client, type MessageCreateOptions } from 'discord.js';

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

/** Deletes a tracked post and distinguishes missing resources from a permission refusal. */
export async function deletePost(client: Client, channelId: string, messageId: string): Promise<DeleteOutcome> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return 'gone';
    await channel.messages.delete(messageId);
    return 'deleted';
  } catch (error) {
    if (isGone(error)) return 'gone';
    if (error instanceof DiscordAPIError && (error.code === RESTJSONErrorCodes.MissingAccess || error.code === RESTJSONErrorCodes.MissingPermissions)) return 'forbidden';
    throw error;
  }
}

export async function sendDm(client: Client, userId: string, message: WebhookMessage): Promise<'sent' | 'closed'> {
  try {
    await client.users.send(userId, {
      content: message.content, embeds: message.embeds, components: message.components,
      flags: message.flags as MessageCreateOptions['flags'], allowedMentions: message.allowedMentions ?? { parse: [] },
      files: message.files?.map(file => ({ name: file.name, attachment: file.data })),
    });
    return 'sent';
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return 'closed';
    throw stripRequestBody(error);
  }
}
