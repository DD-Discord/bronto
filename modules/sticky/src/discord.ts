import {
  ChannelType,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  Routes,
  type APIChannel,
  type APIMessage,
  type APIWebhook,
  type Client,
} from 'discord.js';
import { sendableEmbeds, type StickyMessage } from './message.js';

export interface WebhookCredentials {
  id: string;
  token: string;
}

/** Where a sticky posts: its webhook, and the thread when the sticky lives in one. */
export interface PostTarget extends WebhookCredentials {
  threadId: string | null;
}

export interface ChannelInfo {
  guildId: string | null;
  isThread: boolean;
  parentId: string | null;
}

export interface PostOptions {
  silent: boolean;
  username: string;
  avatarUrl?: string;
}

export class UnknownMessageError extends Error {
  constructor() {
    super('Unknown message');
    this.name = 'UnknownMessageError';
  }
}

export class UnknownWebhookError extends Error {
  constructor() {
    super('Unknown webhook');
    this.name = 'UnknownWebhookError';
  }
}

/** The template cannot be used; the message explains why, for the user. */
export class TemplateUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TemplateUnavailableError';
  }
}

export class MissingWebhookPermissionError extends Error {
  readonly channelId: string;

  constructor(channelId: string) {
    super(`Missing Manage Webhooks in channel ${channelId}`);
    this.name = 'MissingWebhookPermissionError';
    this.channelId = channelId;
  }
}

/** Every Discord call the sticky module makes. */
export interface StickyDiscord {
  fetchTemplate(guildId: string, channelId: string, messageId: string): Promise<StickyMessage>;
  /** A webhook on the channel that this application owns, created when there is none. */
  ensureWebhook(channelId: string, name: string): Promise<WebhookCredentials>;
  createWebhook(channelId: string, name: string): Promise<WebhookCredentials>;
  /** The token of a webhook on the channel if Discord reveals it. */
  findWebhookToken(channelId: string, webhookId: string): Promise<string | null>;
  /** Deletes a webhook through its token; an unknown webhook counts as deleted. */
  deleteWebhook(webhook: WebhookCredentials): Promise<void>;
  /** Deletes a webhook with the bot's permissions; an unknown webhook counts as deleted. */
  deleteWebhookById(webhookId: string): Promise<void>;
  /** Null when the channel is gone or the bot cannot see it. */
  channelInfo(channelId: string): Promise<ChannelInfo | null>;
  /** Posts through the webhook and returns the new message's ID. */
  send(target: PostTarget, message: StickyMessage, options: PostOptions): Promise<string>;
  deleteMessage(target: PostTarget, messageId: string): Promise<void>;
  /** Deletes any message with the bot's permissions; an unknown message counts as deleted. */
  deleteChannelMessage(channelId: string, messageId: string): Promise<void>;
}

const THREAD_TYPES = new Set<ChannelType>([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

function codeOf(error: unknown): number | null {
  return error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null;
}

function isPermissionError(error: unknown): boolean {
  const code = codeOf(error);
  return code === RESTJSONErrorCodes.MissingAccess || code === RESTJSONErrorCodes.MissingPermissions;
}

/** Removes a webhook token from a REST error's url and message so it never reaches logs. */
function redactToken(error: unknown, token: string): unknown {
  if (!(error instanceof Error)) return error;
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

/** Sticky's Discord access through the client's REST API; webhook calls use the webhook token, not bot auth. */
export function createRestStickyDiscord(client: Pick<Client, 'rest' | 'application'>): StickyDiscord {
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

  return {
    async fetchTemplate(guildId, channelId, messageId) {
      let channel: APIChannel;
      try {
        channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
      } catch (error) {
        if (codeOf(error) !== null) throw new TemplateUnavailableError('I cannot see its channel.');
        throw error;
      }
      if (!('guild_id' in channel) || channel.guild_id !== guildId) throw new TemplateUnavailableError('it is not in this server.');
      try {
        const message = (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
        return { content: message.content, embeds: sendableEmbeds(message.embeds) };
      } catch (error) {
        const code = codeOf(error);
        if (code === RESTJSONErrorCodes.UnknownMessage) throw new TemplateUnavailableError('it does not exist.');
        if (code !== null) throw new TemplateUnavailableError('I am not allowed to read it.');
        throw error;
      }
    },

    async ensureWebhook(channelId, name) {
      const applicationId = client.application?.id ?? null;
      const owned = (await listWebhooks(channelId)).find(
        (webhook) => applicationId !== null && webhook.application_id === applicationId && webhook.token !== undefined,
      );
      return owned === undefined ? createWebhook(channelId, name) : { id: owned.id, token: owned.token! };
    },

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

    async channelInfo(channelId) {
      try {
        const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
        return {
          guildId: 'guild_id' in channel ? (channel.guild_id ?? null) : null,
          isThread: THREAD_TYPES.has(channel.type),
          parentId: 'parent_id' in channel ? (channel.parent_id ?? null) : null,
        };
      } catch (error) {
        if (codeOf(error) === RESTJSONErrorCodes.UnknownChannel || isPermissionError(error)) return null;
        throw error;
      }
    },

    async send(target, message, options) {
      const query = threadQuery(target.threadId);
      query.set('wait', 'true');
      query.sort();
      const body: Record<string, unknown> = { username: options.username };
      if (options.avatarUrl !== undefined) body.avatar_url = options.avatarUrl;
      if (message.content !== '') body.content = message.content;
      body.embeds = message.embeds;
      body.flags = options.silent ? MessageFlags.SuppressNotifications : 0;
      try {
        const sent = (await rest.post(Routes.webhook(target.id, target.token), { body, query, auth: false })) as APIMessage;
        return sent.id;
      } catch (error) {
        if (codeOf(error) === RESTJSONErrorCodes.UnknownWebhook) throw new UnknownWebhookError();
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
        const code = codeOf(error);
        if (code === RESTJSONErrorCodes.UnknownMessage) throw new UnknownMessageError();
        if (code === RESTJSONErrorCodes.UnknownWebhook) throw new UnknownWebhookError();
        throw redactToken(error, target.token);
      }
    },

    async deleteChannelMessage(channelId, messageId) {
      try {
        await rest.delete(Routes.channelMessage(channelId, messageId));
      } catch (error) {
        const code = codeOf(error);
        if (code !== RESTJSONErrorCodes.UnknownMessage && code !== RESTJSONErrorCodes.UnknownChannel) throw error;
      }
    },
  };
}
