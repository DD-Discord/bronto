import { DiscordAPIError, RESTJSONErrorCodes, type Client, type MessageCreateOptions, type WebhookMessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import {
  MissingWebhookPermissionError, UnknownWebhookError, ensureWebhook, resolveWebhook, stripRequestBody, withWebhookErrors,
  type IncomingWebhook, type WebhookMessage, type WebhookTarget,
} from '../webhooks/index.js';

const MAX_USERNAME = 80;

const isGone = (error: unknown) => error instanceof DiscordAPIError &&
  (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel);
const isChannelLost = (error: unknown): boolean => error instanceof DiscordAPIError &&
  (error.code === RESTJSONErrorCodes.UnknownChannel || error.code === RESTJSONErrorCodes.MissingAccess);

/** Sends a message to a user's DMs; `'closed'` when they don't accept them. */
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

/** Deletes a message and distinguishes missing resources from a permission refusal. */
export async function deleteMessage(client: Client, channelId: string, messageId: string): Promise<'deleted' | 'gone' | 'forbidden'> {
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

/** The webhook a module stores for its log channel. */
export interface LogTarget {
  channelId: string;
  threadId: string | null;
  webhookId: string;
  webhookToken: string;
}

/** A rejected sender name is retried once under the webhook's own name. */
async function send(client: Client, target: WebhookTarget, message: WebhookMessage, sender: { username: string; avatarUrl: string }, resolved?: IncomingWebhook): Promise<void> {
  const webhook = resolved ?? await resolveWebhook(client, target);
  const payload: WebhookMessageCreateOptions = {
    content: message.content, embeds: message.embeds, components: message.components,
    flags: message.flags as WebhookMessageCreateOptions['flags'], withComponents: true,
    allowedMentions: message.allowedMentions ?? { parse: [] }, threadId: target.threadId ?? undefined,
    files: message.files?.map(file => ({ name: file.name, attachment: file.data })),
    username: sender.username, avatarURL: sender.avatarUrl,
  };
  try { await withWebhookErrors(target.token, () => webhook.send(payload)); }
  catch (error) {
    if (!(error instanceof DiscordAPIError) || error.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType) throw error;
    await withWebhookErrors(target.token, () => webhook.send({ ...payload, username: undefined }));
  }
}

/**
 * Posts a message through a log channel's webhook under the sender's name and avatar. An unknown webhook is recreated
 * once and handed to `replaced` for storing. A lost channel or missing permission drops the message with a warning.
 */
export async function sendLogReport(
  ctx: { client: Client; log: Logger },
  target: LogTarget,
  message: WebhookMessage,
  sender: { username: string; avatarUrl: string },
  options: { webhookName: string; replaced: (webhook: { id: string; token: string; threadId: string | null }) => Promise<void> },
): Promise<'sent' | 'dropped'> {
  const from = { username: Array.from(sender.username).slice(0, MAX_USERNAME).join(''), avatarUrl: sender.avatarUrl };
  const stored = { id: target.webhookId, token: target.webhookToken };
  const dropped = (): 'dropped' => {
    ctx.log.warn({ channelId: target.channelId }, 'Dropped a report: the log channel or webhook is not usable');
    return 'dropped';
  };
  try {
    await send(ctx.client, { ...stored, threadId: target.threadId }, message, from);
    return 'sent';
  } catch (error) {
    if (isChannelLost(error)) return dropped();
    if (!(error instanceof UnknownWebhookError)) throw error;
  }
  try {
    const { webhook, threadId } = await ensureWebhook(ctx.client, target.channelId, stored, options.webhookName);
    await options.replaced({ id: webhook.id, token: webhook.token, threadId });
    await send(ctx.client, { id: webhook.id, token: webhook.token, threadId }, message, from, webhook);
    return 'sent';
  } catch (error) {
    if (error instanceof UnknownWebhookError || error instanceof MissingWebhookPermissionError || isChannelLost(error)) return dropped();
    throw error;
  }
}
