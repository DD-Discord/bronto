import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Webhook, type WebhookType } from 'discord.js';
import { MissingWebhookPermissionError, UnknownWebhookError, withWebhookErrors } from './errors.js';
import type { WebhookCredentials } from './webhooks.js';

export type IncomingWebhook = Webhook<WebhookType.Incoming>;
export interface ResolvedWebhook { webhook: IncomingWebhook; threadId: string | null; }

/** Resolves stored credentials through the bot client's shared REST manager. */
export function resolveWebhook(client: Client, credentials: WebhookCredentials): Promise<IncomingWebhook> {
  return withWebhookErrors(credentials.token, async () => {
    const webhook = await client.fetchWebhook(credentials.id, credentials.token);
    if (!webhook.isIncoming() || !webhook.token) throw new UnknownWebhookError();
    return webhook;
  });
}

/** Reuses a known webhook on the target channel, creating on a thread's parent when needed. */
export async function ensureWebhook(client: Client, channelId: string, known: WebhookCredentials | null, name: string): Promise<ResolvedWebhook> {
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error('The webhook channel is unavailable');
  const threadId = channel.isThread() ? channel.id : null;
  const parentId = channel.isThread() ? channel.parentId : channel.id;
  if (!parentId) throw new Error('The thread has no parent channel');
  if (known) {
    try {
      const webhook = await resolveWebhook(client, known);
      if (webhook.channelId === parentId) return { webhook, threadId };
    } catch (error) {
      if (!(error instanceof UnknownWebhookError)) throw error;
    }
  }
  const parent = channel.isThread() ? await client.channels.fetch(parentId) : channel;
  if (!parent || !('createWebhook' in parent)) throw new Error('This channel cannot host a webhook');
  try {
    const webhook = await parent.createWebhook({ name });
    return { webhook, threadId };
  } catch (error) {
    if (error instanceof DiscordAPIError && (error.code === RESTJSONErrorCodes.MissingAccess || error.code === RESTJSONErrorCodes.MissingPermissions)) {
      throw new MissingWebhookPermissionError(parentId);
    }
    throw error;
  }
}
