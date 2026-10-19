import { createWebhooks, stripRequestBody, type WebhookMessage, type Webhooks } from '@bronto/core';
import { DiscordAPIError, RESTJSONErrorCodes, Routes, type APIMessage, type Client } from 'discord.js';

export interface FetchedPost {
  content: string;
  attachmentCount: number;
}

/** 'gone': the post or its channel no longer exists; 'forbidden': the bot may not delete it. */
export type DeleteOutcome = 'deleted' | 'gone' | 'forbidden';

/** Every Discord call the autodelete module makes. */
export interface AutodeleteDiscord extends Pick<Webhooks, 'ensureWebhook' | 'checkWebhook' | 'deleteWebhook' | 'send'> {
  /** The post's content, or null when the message or its channel no longer exists. */
  fetchPost(channelId: string, messageId: string): Promise<FetchedPost | null>;
  deletePost(channelId: string, messageId: string): Promise<DeleteOutcome>;
  /** 'closed' when the member does not accept DMs from the bot. */
  sendDm(userId: string, message: WebhookMessage): Promise<'sent' | 'closed'>;
}

function codeOf(error: unknown): number | null {
  return error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null;
}

const GONE_CODES: number[] = [RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel];
const FORBIDDEN_CODES: number[] = [RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions];

/** Autodelete's Discord access through the client's REST API. */
export function createRestAutodeleteDiscord(client: Pick<Client, 'rest'>): AutodeleteDiscord {
  const { rest } = client;
  const webhooks = createWebhooks(client);

  return {
    ensureWebhook: webhooks.ensureWebhook,
    checkWebhook: webhooks.checkWebhook,
    deleteWebhook: webhooks.deleteWebhook,
    send: webhooks.send,

    async fetchPost(channelId, messageId) {
      try {
        const message = (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
        return { content: message.content, attachmentCount: message.attachments.length };
      } catch (error) {
        const code = codeOf(error);
        if (code !== null && GONE_CODES.includes(code)) return null;
        throw error;
      }
    },

    async deletePost(channelId, messageId) {
      try {
        await rest.delete(Routes.channelMessage(channelId, messageId));
        return 'deleted';
      } catch (error) {
        const code = codeOf(error);
        if (code !== null && GONE_CODES.includes(code)) return 'gone';
        if (code !== null && FORBIDDEN_CODES.includes(code)) return 'forbidden';
        throw error;
      }
    },

    async sendDm(userId, message) {
      try {
        const channel = (await rest.post(Routes.userChannels(), { body: { recipient_id: userId } })) as { id: string };
        await rest.post(Routes.channelMessages(channel.id), {
          body: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
            flags: message.flags,
            allowed_mentions: message.allowedMentions ?? { parse: [] },
          },
          files: message.files,
        });
        return 'sent';
      } catch (error) {
        if (codeOf(error) === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return 'closed';
        throw stripRequestBody(error);
      }
    },
  };
}
