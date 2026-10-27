import type { Message } from 'discord.js';

const ATTACHMENT_LINK = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\/([^/?#]+)/;

export interface AttachmentLink {
  id: string;
  name: string;
  url: string;
}

/**
 * The attachments a served message carries. Discord lists an attachment that an embed shows (`attachment://<name>`)
 * only as that embed URL, not under `attachments`.
 */
export function messageAttachments(message: Message): AttachmentLink[] {
  const links: AttachmentLink[] = message.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, url: attachment.url }));
  for (const embed of message.embeds) {
    for (const url of [embed.image?.url, embed.thumbnail?.url, embed.author?.iconURL, embed.footer?.iconURL]) {
      const match = url === undefined ? null : ATTACHMENT_LINK.exec(url);
      if (match === null || links.some((link) => link.id === match[1])) continue;
      links.push({ id: match[1]!, name: decodeURIComponent(match[2]!), url: url! });
    }
  }
  return links;
}
