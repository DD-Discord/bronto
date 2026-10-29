import { ensureWebhook, type ResolvedWebhook } from '@bronto/core';
import type { Client } from 'discord.js';

export const MOVE_WEBHOOK_NAME = 'Move';

/**
 * The bot's own `Move` webhook on the channel (a thread's parent), created when there is none. Webhooks of other
 * applications, of users and of other modules are never used.
 */
export async function findMoveWebhook(client: Client, channelId: string): Promise<ResolvedWebhook> {
  const channel = await client.channels.fetch(channelId);
  if (channel === null) throw new Error('The webhook channel is unavailable');
  const threadId = channel.isThread() ? channel.id : null;
  const parent = channel.isThread() ? channel.parentId === null ? null : await client.channels.fetch(channel.parentId) : channel;
  if (parent !== null && 'fetchWebhooks' in parent) {
    const own = (await parent.fetchWebhooks()).find(
      (webhook) => webhook.applicationId === client.application?.id && webhook.name === MOVE_WEBHOOK_NAME && webhook.isIncoming() && webhook.token !== null,
    );
    if (own?.isIncoming()) return { webhook: own, threadId };
  }
  return ensureWebhook(client, channelId, null, MOVE_WEBHOOK_NAME);
}
