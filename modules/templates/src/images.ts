import type { Message } from 'discord.js';

/** How long a download from Discord's CDN may take; a timeout counts as a failed download. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Refetch a link when it expires within this long. */
export const REFRESH_MARGIN_MS = 3_600_000;

/** When a signed Discord CDN link stops working, from its hex `ex` (unix seconds) parameter; null if absent or malformed. */
export function linkExpiry(url: string): Date | null {
  let value: string | null;
  try {
    value = new URL(url).searchParams.get('ex');
  } catch {
    return null;
  }
  if (value === null || !/^[0-9a-f]+$/i.test(value)) return null;
  const seconds = Number.parseInt(value, 16);
  return Number.isSafeInteger(seconds) ? new Date(seconds * 1000) : null;
}

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
