import type { APIEmbed } from 'discord.js';

/** What a template posts: message text and at most one embed. */
export interface TemplateMessage {
  content: string;
  embed: APIEmbed | null;
}
