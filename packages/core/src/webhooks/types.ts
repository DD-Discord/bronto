import type { APIAllowedMentions, APIEmbed, APIMessageTopLevelComponent } from 'discord.js';

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

