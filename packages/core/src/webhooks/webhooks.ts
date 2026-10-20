import { UnknownMessageError, UnknownWebhookError, MissingWebhookPermissionError, stripRequestBody } from './errors.js';
export { UnknownMessageError, UnknownWebhookError, MissingWebhookPermissionError, stripRequestBody } from './errors.js';
import {
  ChannelType,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  Routes,
  type APIAllowedMentions,
  type APIChannel,
  type APIEmbed,
  type APIMessage,
  type APIMessageTopLevelComponent,
  type APIWebhook,
  type Client,
} from 'discord.js';

export interface WebhookCredentials {
  id: string;
  token: string;
}

/** Where a webhook posts: the webhook, and the thread when the post goes into one. */
export interface WebhookTarget extends WebhookCredentials {
  threadId: string | null;
}

export interface WebhookMessage {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIMessageTopLevelComponent[];
  flags?: number;
  allowedMentions?: APIAllowedMentions;
  files?: { name: string; data: Buffer }[];
}

export interface WebhookSendOptions {
  username?: string;
  avatarUrl?: string;
  /** Posts without notifications. */
  silent?: boolean;
}

export interface Webhooks {
  /**
   * A webhook that posts to the channel or thread. `known` is reused when it still exists and belongs to the
   * webhook channel (the parent for a thread); otherwise a new webhook is created there. Pass only webhooks whose IDs
   * the caller stores.
   */
  ensureWebhook(channelId: string, known: WebhookCredentials | null, defaultName: string): Promise<WebhookTarget>;
  /** The channel a webhook posts to, or null when it is deleted or its token is invalid. No bot auth. */
  checkWebhook(webhook: WebhookCredentials): Promise<{ channelId: string } | null>;
  createWebhook(channelId: string, name: string): Promise<WebhookCredentials>;
  /** The token of a webhook on the channel if Discord reveals it. */
  findWebhookToken(channelId: string, webhookId: string): Promise<string | null>;
  /** Deletes a webhook through its token; an unknown webhook counts as deleted. */
  deleteWebhook(webhook: WebhookCredentials): Promise<void>;
  /** Deletes a webhook with the bot's permissions; an unknown webhook counts as deleted. */
  deleteWebhookById(webhookId: string): Promise<void>;
  /** Posts through the webhook and returns the new message's ID. */
  send(target: WebhookTarget, message: WebhookMessage, options?: WebhookSendOptions): Promise<string>;
  deleteMessage(target: WebhookTarget, messageId: string): Promise<void>;
}

const THREAD_TYPES = new Set<ChannelType>([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

function codeOf(error: unknown): number | null {
  return error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null;
}

/** A deleted webhook, or one whose token was revoked: either way it can no longer post. */
function isWebhookGone(error: unknown): boolean {
  const code = codeOf(error);
  return code === RESTJSONErrorCodes.UnknownWebhook || code === RESTJSONErrorCodes.InvalidWebhookToken;
}

function isPermissionError(error: unknown): boolean {
  const code = codeOf(error);
  return code === RESTJSONErrorCodes.MissingAccess || code === RESTJSONErrorCodes.MissingPermissions;
}

/** Removes a webhook token from a REST error's url and message, and its request body, so none reaches logs. */
function redactToken(error: unknown, token: string): unknown {
  if (!(error instanceof Error)) return error;
  stripRequestBody(error);
  const target = error as Error & { url?: unknown };
  if (typeof target.url === 'string') target.url = target.url.replaceAll(token, '…');
  error.message = error.message.replaceAll(token, '…');
  return error;
}

function threadQuery(threadId: string | null): URLSearchParams {
  const query = new URLSearchParams();
  if (threadId !== null) query.set('thread_id', threadId);
  return query;
}

/** Webhook access through the client's REST API; calls that act through a webhook use its token, not bot auth. */
export function createWebhooks(client: Pick<Client, 'rest'>): Webhooks {
  const { rest } = client;

  async function listWebhooks(channelId: string): Promise<APIWebhook[]> {
    try {
      return (await rest.get(Routes.channelWebhooks(channelId))) as APIWebhook[];
    } catch (error) {
      if (isPermissionError(error)) throw new MissingWebhookPermissionError(channelId);
      throw error;
    }
  }

  async function createWebhook(channelId: string, name: string): Promise<WebhookCredentials> {
    try {
      const webhook = (await rest.post(Routes.channelWebhooks(channelId), { body: { name } })) as APIWebhook;
      return { id: webhook.id, token: webhook.token! };
    } catch (error) {
      if (isPermissionError(error)) throw new MissingWebhookPermissionError(channelId);
      throw error;
    }
  }

  async function checkWebhook(webhook: WebhookCredentials): Promise<{ channelId: string } | null> {
    try {
      const found = (await rest.get(Routes.webhook(webhook.id, webhook.token), { auth: false })) as APIWebhook;
      return found.channel_id === null ? null : { channelId: found.channel_id };
    } catch (error) {
      if (isWebhookGone(error)) return null;
      throw redactToken(error, webhook.token);
    }
  }

  return {
    async ensureWebhook(channelId, known, defaultName) {
      const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
      const isThread = THREAD_TYPES.has(channel.type);
      const parentId = 'parent_id' in channel ? (channel.parent_id ?? null) : null;
      const webhookChannelId = parentId !== null && isThread ? parentId : channelId;
      const threadId = isThread ? channelId : null;
      if (known !== null) {
        const current = await checkWebhook(known);
        if (current?.channelId === webhookChannelId) return { ...known, threadId };
      }
      return { ...(await createWebhook(webhookChannelId, defaultName)), threadId };
    },

    checkWebhook,
    createWebhook,

    async findWebhookToken(channelId, webhookId) {
      return (await listWebhooks(channelId)).find((webhook) => webhook.id === webhookId)?.token ?? null;
    },

    async deleteWebhook(webhook) {
      try {
        await rest.delete(Routes.webhook(webhook.id, webhook.token), { auth: false });
      } catch (error) {
        if (codeOf(error) !== RESTJSONErrorCodes.UnknownWebhook) throw redactToken(error, webhook.token);
      }
    },

    async deleteWebhookById(webhookId) {
      try {
        await rest.delete(Routes.webhook(webhookId));
      } catch (error) {
        if (codeOf(error) !== RESTJSONErrorCodes.UnknownWebhook) throw error;
      }
    },

    async send(target, message, options = {}) {
      const query = threadQuery(target.threadId);
      query.set('wait', 'true');
      if (message.components !== undefined) query.set('with_components', 'true');
      query.sort();
      const body: Record<string, unknown> = {};
      if (options.username !== undefined) body.username = options.username;
      if (options.avatarUrl !== undefined) body.avatar_url = options.avatarUrl;
      if (message.content !== undefined && message.content !== '') body.content = message.content;
      if (message.embeds !== undefined) body.embeds = message.embeds;
      if (message.components !== undefined) body.components = message.components;
      body.flags = (message.flags ?? 0) | (options.silent === true ? MessageFlags.SuppressNotifications : 0);
      body.allowed_mentions = message.allowedMentions ?? { parse: [] };
      try {
        const sent = (await rest.post(Routes.webhook(target.id, target.token), {
          body,
          query,
          auth: false,
          ...(message.files !== undefined && { files: message.files }),
        })) as APIMessage;
        return sent.id;
      } catch (error) {
        if (isWebhookGone(error)) throw new UnknownWebhookError();
        throw redactToken(error, target.token);
      }
    },

    async deleteMessage(target, messageId) {
      try {
        await rest.delete(Routes.webhookMessage(target.id, target.token, messageId), {
          query: threadQuery(target.threadId),
          auth: false,
        });
      } catch (error) {
        if (codeOf(error) === RESTJSONErrorCodes.UnknownMessage) throw new UnknownMessageError();
        if (isWebhookGone(error)) throw new UnknownWebhookError();
        throw redactToken(error, target.token);
      }
    },
  };
}
