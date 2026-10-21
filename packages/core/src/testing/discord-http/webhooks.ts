import type { APIWebhook } from 'discord.js';
import type { FakeHttpAnswer, RecordedRequest } from '../rest.js';
import { readPayload, sendMessage } from './messages.js';
import { error, gone, ok } from './responses.js';
import { route } from './router.js';
import type { DiscordState } from './state.js';

type WebhookParams = { webhookId: string; token?: string };

export function webhookRoutes(state: DiscordState) {
  function withWebhook<P extends WebhookParams>(
    answer: (webhook: APIWebhook, request: RecordedRequest, params: P) => ReturnType<FakeHttpAnswer>,
  ) {
    return (request: RecordedRequest, params: P): ReturnType<FakeHttpAnswer> => {
      const webhook = state.webhooks.get(params.webhookId);
      if (!webhook) return error(10015);
      if (params.token !== undefined && params.token !== webhook.token) return error(50027, 401);
      return answer(webhook, request, params);
    };
  }

  const fetch = withWebhook(webhook => ok(webhook));
  const remove = withWebhook(webhook => {
    state.webhooks.delete(webhook.id);
    state.deletedWebhooks.push(webhook.id);
    return gone();
  });
  const send = withWebhook((webhook, request) => {
    const threadId = new URLSearchParams(request.query).get('thread_id');
    return sendMessage(state, request, threadId ?? webhook.channel_id!, webhook.id);
  });
  const deleteMessage = withWebhook((webhook, request, { messageId }: WebhookParams & { messageId: string }) => {
    const message = state.messages.get(messageId);
    const channelId = new URLSearchParams(request.query).get('thread_id') ?? webhook.channel_id;
    if (!message || message.webhook_id !== webhook.id || message.channel_id !== channelId) return error(10008);
    state.messages.delete(messageId);
    state.deleted.push(messageId);
    return gone();
  });
  const editMessage = withWebhook(async (webhook, request, { messageId }: WebhookParams & { messageId: string }) => {
    const message = state.messages.get(messageId);
    const channelId = new URLSearchParams(request.query).get('thread_id') ?? webhook.channel_id;
    if (!message || message.webhook_id !== webhook.id || message.channel_id !== channelId) return error(10008);
    const { body } = await readPayload(request);
    if (body.content !== undefined) message.content = (body.content as string | null) ?? '';
    if (body.embeds !== undefined) message.embeds = (body.embeds as typeof message.embeds | null) ?? [];
    message.edited_timestamp = new Date().toISOString();
    state.edited.push(messageId);
    return ok(state.present(message));
  });

  return [
    route('POST', '/channels/:channelId/webhooks', (_request, { channelId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const credentials = state.addWebhook(channelId);
      return ok(state.webhooks.get(credentials.id));
    }),
    route('GET', '/webhooks/:webhookId', fetch),
    route('GET', '/webhooks/:webhookId/:token', fetch),
    route('DELETE', '/webhooks/:webhookId', remove),
    route('DELETE', '/webhooks/:webhookId/:token', remove),
    route('POST', '/webhooks/:webhookId', send),
    route('POST', '/webhooks/:webhookId/:token', send),
    route('DELETE', '/webhooks/:webhookId/:token/messages/:messageId', deleteMessage),
    route('PATCH', '/webhooks/:webhookId/:token/messages/:messageId', editMessage),
  ];
}
