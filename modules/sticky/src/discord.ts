import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { sendableEmbeds, type StickyMessage } from './message.js';

export class TemplateUnavailableError extends Error {
  constructor(reason: string) { super(reason); this.name = 'TemplateUnavailableError'; }
}

/** Reads current template content and refuses messages outside this server. */
export async function fetchTemplate(client: Client, guildId: string, channelId: string, messageId: string): Promise<StickyMessage> {
  let channel;
  try { channel = await client.channels.fetch(channelId, { force: true }); }
  catch (error) {
    if (error instanceof DiscordAPIError) throw new TemplateUnavailableError('I cannot see its channel.');
    throw error;
  }
  if (!channel || !('guildId' in channel) || channel.guildId !== guildId) throw new TemplateUnavailableError('it is not in this server.');
  if (!channel.isTextBased()) throw new TemplateUnavailableError('I am not allowed to read it.');
  try {
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    return { content: message.content, embeds: sendableEmbeds(message.embeds.map(embed => embed.toJSON())) };
  } catch (error) {
    if (error instanceof DiscordAPIError) {
      if (error.code === RESTJSONErrorCodes.UnknownMessage) throw new TemplateUnavailableError('it does not exist.');
      throw new TemplateUnavailableError('I am not allowed to read it.');
    }
    throw error;
  }
}
