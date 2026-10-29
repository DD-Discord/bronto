import { ChannelType, MessageFlags, type APIAttachment, type APIEmbed, type APIMessage } from 'discord.js';
import type { WebhookMessage } from '../../webhooks/types.js';
import type { FakeRestAnswer, RecordedRequest } from '../rest.js';
import { guessContentType } from './state.js';
import { route } from './router.js';
import { error, gone, ok } from './responses.js';
import type { DiscordState } from './state.js';

/** Discord rejects bulk deletes of messages older than 14 days, judged by the snowflake's timestamp. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 3600_000;
const DISCORD_EPOCH = 1420070400000n;
const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const newestFirst = (a: APIMessage, b: APIMessage): number => (BigInt(a.id) < BigInt(b.id) ? 1 : -1);

export function messageRoutes(state: DiscordState) {
  return [
    route('GET', '/channels/:channelId/messages', (request, { channelId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const query = new URLSearchParams(request.query);
      const limit = query.has('limit') ? Number(query.get('limit')) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(50035, 400);
      const inChannel = [...state.messages.values()].filter(m => m.channel_id === channelId).sort(newestFirst);
      const after = query.get('after'), before = query.get('before'), around = query.get('around');
      let page: APIMessage[];
      if (after) page = inChannel.filter(m => BigInt(m.id) > BigInt(after)).slice(-limit);
      else if (before) page = inChannel.filter(m => BigInt(m.id) < BigInt(before)).slice(0, limit);
      else if (around) {
        const newer = inChannel.filter(m => BigInt(m.id) > BigInt(around)).slice(-Math.floor(limit / 2));
        page = [...newer, ...inChannel.filter(m => BigInt(m.id) <= BigInt(around)).slice(0, limit - newer.length)];
      } else page = inChannel.slice(0, limit);
      return ok(page.map(m => state.present(m)));
    }),
    route('POST', '/channels/:channelId/messages/bulk-delete', async (request, { channelId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const { body } = await readPayload(request);
      const ids = Array.isArray(body.messages) ? body.messages as string[] : [];
      if (ids.length < 2 || ids.length > 100) return error(50035, 400);
      const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
      if (ids.some(id => state.messages.get(id)?.channel_id !== channelId || snowflakeTime(id) < cutoff)) return error(50034, 400);
      for (const id of ids) {
        state.messages.delete(id);
        state.botDeleted.push(id);
      }
      return gone();
    }),
    route('GET', '/channels/:channelId/messages/:messageId', (_request, { channelId, messageId }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const message = state.messages.get(messageId);
      return message?.channel_id === channelId ? ok(state.present(message)) : error(10008);
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
    route('PUT', '/channels/:channelId/messages/:messageId/reactions/:emoji/@me', (_request, { channelId, messageId, emoji }) => {
      if (!state.channels.has(channelId)) return error(10003);
      const message = state.messages.get(messageId);
      if (!message || message.channel_id !== channelId) return error(10008);
      state.reactions.push({ messageId, emoji });
      return gone();
    }),
    route('PATCH', '/channels/:channelId/messages/:messageId', async (request, { channelId, messageId }) => {
      const channel = state.channels.get(channelId);
      if (!channel) return error(10003);
      const message = state.messages.get(messageId);
      if (!message || message.channel_id !== channelId) return error(10008);
      if (isThread(channel.type) && 'thread_metadata' in channel && channel.thread_metadata?.archived) return error(50083, 400);
      const { body, files } = await readPayload(request);
      const kept = body.attachments === undefined
        ? message.attachments
        : message.attachments.filter(a => (body.attachments as { id: string }[]).some(entry => String(entry.id) === a.id && !files.has(String(entry.id))));
      for (const attachment of message.attachments) if (!kept.includes(attachment)) state.files.delete(attachment.id);
      const { attachments: _, ...fields } = body;
      Object.assign(message, fields, { attachments: [...kept, ...storeUploads(state, channelId, body, files, body.attachments === undefined)], edited_timestamp: new Date().toISOString() });
      return ok(state.present(message));
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
  const { body, files } = await readPayload(request);
  const id = state.newId();
  state.addMessage(channelId, id, {
    content: body.content as string ?? '',
    embeds: body.embeds as APIEmbed[] ?? [],
    webhookId,
  });
  const message = state.messages.get(id)!;
  const { attachments: _, ...fields } = body;
  Object.assign(message, fields, { id, channel_id: channelId, flags: body.flags ?? 0 });
  message.attachments = storeUploads(state, channelId, body, files, true);

  const content: WebhookMessage = {
    ...(body.content !== undefined ? { content: body.content as string } : {}),
    ...(body.embeds !== undefined ? { embeds: body.embeds as APIEmbed[] } : {}),
    ...(body.components !== undefined ? { components: body.components as WebhookMessage['components'] } : {}),
    ...(body.flags !== undefined ? { flags: body.flags as number } : {}),
    ...(files.size ? { files: [...files.values()].map(({ name, data }) => ({ name, data })) } : {}),
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
      options: {
        ...options, silent: Boolean(Number(body.flags) & MessageFlags.SuppressNotifications),
        flags: Number(body.flags ?? 0), allowedMentions: body.allowed_mentions,
      },
      files: message.attachments.map(({ filename, description, size }) => ({ name: filename, ...(description ? { description } : {}), size })),
      startedAt: performance.now(),
    });
  } else {
    const channel = state.channels.get(channelId);
    if (channel?.type === ChannelType.DM) {
      state.dms.push({ userId: channel.recipients?.[0]?.id ?? '', message: content });
    }
  }
  return ok(state.present(message));
}

export const isThread = (type: ChannelType): boolean =>
  type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;

export interface Upload { name: string; type: string; data: Buffer }

/** A request body as JSON, with the files of a multipart request keyed by their `files[n]` index. */
export async function readPayload(request: RecordedRequest): Promise<{ body: Record<string, unknown>; files: Map<string, Upload> }> {
  const files = new Map<string, Upload>();
  if (!(request.body instanceof FormData)) return { body: (request.body ?? {}) as Record<string, unknown>, files };
  for (const [key, value] of request.body) {
    const index = /^files\[(\d+)\]$/.exec(key)?.[1];
    if (index !== undefined && value instanceof File) {
      files.set(index, { name: value.name, type: value.type, data: Buffer.from(await value.arrayBuffer()) });
    }
  }
  return { body: JSON.parse(request.body.get('payload_json') as string), files };
}

/**
 * Stores the uploaded files and returns their attachment objects. `attachments` entries whose id is an upload index
 * name the file; without entries every upload becomes an attachment.
 */
export function storeUploads(
  state: DiscordState, channelId: string, body: Record<string, unknown>, files: Map<string, Upload>, all: boolean,
): APIAttachment[] {
  const entries = (body.attachments as { id: string | number; filename?: string; description?: string }[] | undefined) ?? [];
  const named = new Map(entries.map(entry => [String(entry.id), entry]));
  const result: APIAttachment[] = [];
  for (const [index, upload] of files) {
    if (!all && !named.has(index)) continue;
    const entry = named.get(index);
    const attachment = state.addFile(channelId, {
      filename: entry?.filename ?? upload.name, data: upload.data, contentType: upload.type || guessContentType(upload.name),
    });
    if (entry?.description) attachment.description = entry.description;
    result.push(attachment);
  }
  return result;
}
