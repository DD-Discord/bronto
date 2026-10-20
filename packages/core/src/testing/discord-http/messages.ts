import { ChannelType, MessageFlags, type APIEmbed } from 'discord.js';
import type { WebhookMessage } from '../../webhooks/types.js';
import type { FakeRestAnswer, RecordedRequest } from '../rest.js';
import { route } from './router.js';
import { error, gone, ok } from './responses.js';
import type { DiscordState } from './state.js';

export function messageRoutes(state: DiscordState) {
  return [
    route('GET', '/channels/:channelId/messages/:messageId', (_request, { channelId, messageId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const message = state.messages.get(messageId);
      return message?.channel_id === channelId ? ok(message) : error(10008);
    }),
    route('DELETE', '/channels/:channelId/messages/:messageId', (_request, { channelId, messageId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const message = state.messages.get(messageId);
      if (!message || message.channel_id !== channelId) return error(10008);
      state.messages.delete(messageId);
      state.botDeleted.push(messageId);
      state.deletedPosts.push(messageId);
      return gone();
    }),
    route('POST', '/channels/:channelId/messages', (request, { channelId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      return sendMessage(state, request, channelId);
    }),
  ];
}

export async function sendMessage(
  state: DiscordState, request: RecordedRequest, channelId: string, webhookId?: string,
): Promise<FakeRestAnswer> {
  const body: Record<string, unknown> = request.body instanceof FormData
    ? JSON.parse(request.body.get('payload_json') as string)
    : request.body as Record<string, unknown>;
  const id = state.newId();
  state.addMessage(channelId, id, {
    content: body.content as string ?? '',
    embeds: body.embeds as APIEmbed[] ?? [],
    webhookId,
  });
  const message = state.messages.get(id)!;
  Object.assign(message, body, { id, channel_id: channelId, flags: body.flags ?? 0 });

  const files: { name: string; data: Buffer }[] = [];
  if (request.body instanceof FormData) {
    for (const [key, value] of request.body) {
      if (key.startsWith('files[') && value instanceof File) {
        files.push({ name: value.name, data: Buffer.from(await value.arrayBuffer()) });
      }
    }
  }
  const content: WebhookMessage = {
    ...(body.content !== undefined ? { content: body.content as string } : {}),
    ...(body.embeds !== undefined ? { embeds: body.embeds as APIEmbed[] } : {}),
    ...(body.components !== undefined ? { components: body.components as WebhookMessage['components'] } : {}),
    ...(body.flags !== undefined ? { flags: body.flags as number } : {}),
    ...(files.length ? { files } : {}),
  };
  if (webhookId) {
    const webhook = state.webhooks.get(webhookId)!;
    const threadId = channelId === webhook.channel_id ? null : channelId;
    const options = {
      ...(body.username !== undefined ? { username: body.username as string } : {}),
      ...(body.avatar_url !== undefined ? { avatarUrl: body.avatar_url as string } : {}),
    };
    state.reports.push({
      target: { id: webhookId, token: webhook.token!, threadId },
      message: content,
      options,
    });
    state.sent.push({
      id, webhookId, channelId: webhook.channel_id!, threadId,
      message: { content: message.content, embeds: message.embeds },
      options: { ...options, silent: Boolean(Number(body.flags) & MessageFlags.SuppressNotifications) },
      startedAt: performance.now(),
    });
  } else {
    const channel = state.channels.get(channelId);
    if (channel?.type === ChannelType.DM) {
      state.dms.push({ userId: channel.recipients?.[0]?.id ?? '', message: content });
    }
  }
  return ok(message);
}
