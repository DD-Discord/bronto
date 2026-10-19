import {
  createWebhooks,
  MissingWebhookPermissionError,
  UnknownMessageError,
  UnknownWebhookError,
  type WebhookCredentials,
  type WebhookTarget,
} from '@bronto/core';
import { ChannelType, DiscordAPIError, RESTJSONErrorCodes, Routes, type APIChannel, type APIMessage, type Client } from 'discord.js';
import { sendableEmbeds, type StickyMessage } from './message.js';

export { MissingWebhookPermissionError, UnknownMessageError, UnknownWebhookError, type WebhookCredentials };

/** Where a sticky posts: its webhook, and the thread when the sticky lives in one. */
export type PostTarget = WebhookTarget;

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

/** The template cannot be used; the message explains why, for the user. */
export class TemplateUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TemplateUnavailableError';
  }
}

/** Every Discord call the sticky module makes. */
export interface StickyDiscord {
  fetchTemplate(guildId: string, channelId: string, messageId: string): Promise<StickyMessage>;
  /** A webhook for the channel or thread: `known` when it is still valid there, otherwise a new one. */
  ensureWebhook(channelId: string, known: WebhookCredentials | null, name: string): Promise<PostTarget>;
  createWebhook(channelId: string, name: string): Promise<WebhookCredentials>;
  /** The token of a webhook on the channel if Discord reveals it. */
  findWebhookToken(channelId: string, webhookId: string): Promise<string | null>;
  /** Deletes a webhook through its token; an unknown webhook counts as deleted. */
  deleteWebhook(webhook: WebhookCredentials): Promise<void>;
  /** Deletes a webhook with the bot's permissions; an unknown webhook counts as deleted. */
  deleteWebhookById(webhookId: string): Promise<void>;
  /** 'gone' when the channel no longer exists, 'forbidden' when the bot cannot see it. */
  channelInfo(channelId: string): Promise<ChannelInfo | 'gone' | 'forbidden'>;
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

/** Sticky's Discord access through the client's REST API; webhook calls use the webhook token, not bot auth. */
export function createRestStickyDiscord(client: Pick<Client, 'rest'>): StickyDiscord {
  const { rest } = client;

  const webhooks = createWebhooks(client);

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

    ensureWebhook: webhooks.ensureWebhook,
    createWebhook: webhooks.createWebhook,
    findWebhookToken: webhooks.findWebhookToken,
    deleteWebhook: webhooks.deleteWebhook,
    deleteWebhookById: webhooks.deleteWebhookById,

    async channelInfo(channelId) {
      try {
        const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
        return {
          guildId: 'guild_id' in channel ? (channel.guild_id ?? null) : null,
          isThread: THREAD_TYPES.has(channel.type),
          parentId: 'parent_id' in channel ? (channel.parent_id ?? null) : null,
        };
      } catch (error) {
        if (codeOf(error) === RESTJSONErrorCodes.UnknownChannel) return 'gone';
        if (isPermissionError(error)) return 'forbidden';
        throw error;
      }
    },

    send: (target, message, options) =>
      webhooks.send(target, { content: message.content, embeds: message.embeds }, options),

    deleteMessage: webhooks.deleteMessage,

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
