import { and, eq } from 'drizzle-orm';
import { DiscordAPIError, RESTJSONErrorCodes, type APIEmbed } from 'discord.js';
import type { TemplatesContext } from './context.js';
import type { TemplateMessage } from './content.js';
import { IMAGE_SLOTS, templateImages, templates, type ImageSlot, type TemplateImage } from './db/schema.js';
import { linkExpiry, REFRESH_MARGIN_MS } from '@bronto/core';
import { messageAttachments } from './images.js';

export { REFRESH_MARGIN_MS };

const UPLOAD_PREFIX = 'attachment://';

/** The slot's URL in the embed, if any. */
export function slotUrl(embed: APIEmbed, slot: ImageSlot): string | undefined {
  switch (slot) {
    case 'image':
      return embed.image?.url;
    case 'thumbnail':
      return embed.thumbnail?.url;
    case 'author_icon':
      return embed.author?.icon_url;
    case 'footer_icon':
      return embed.footer?.icon_url;
  }
}

/** Removes the slot's image from the embed. */
export function clearSlot(embed: APIEmbed, slot: ImageSlot): void {
  if (slot === 'image') delete embed.image;
  else if (slot === 'thumbnail') delete embed.thumbnail;
  else if (slot === 'author_icon' && embed.author) delete embed.author.icon_url;
  else if (slot === 'footer_icon' && embed.footer) delete embed.footer.icon_url;
}

/** The file name a Discord attachment link ends in; null for anything else. */
function linkFileName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null;
  } catch {
    return null;
  }
}

/** Sets the slot's URL; false when the icon has no author name or footer text to belong to. */
export function setSlot(embed: APIEmbed, slot: ImageSlot, url: string): boolean {
  switch (slot) {
    case 'image':
      embed.image = { url };
      break;
    case 'thumbnail':
      embed.thumbnail = { url };
      break;
    case 'author_icon':
      if (!embed.author?.name) return false;
      embed.author = { ...embed.author, icon_url: url };
      break;
    case 'footer_icon':
      if (!embed.footer?.text) return false;
      embed.footer = { ...embed.footer, icon_url: url };
      break;
  }
  return true;
}

/** The preview message's attachment links by attachment ID; empty when the message or thread is gone. */
async function currentLinks(ctx: TemplatesContext, threadId: string, messageId: string): Promise<Map<string, string>> {
  try {
    const channel = await ctx.client.channels.fetch(threadId);
    if (channel === null || !channel.isTextBased()) return new Map();
    const message = await channel.messages.fetch(messageId);
    return new Map(messageAttachments(message).map((attachment) => [attachment.id, attachment.url]));
  } catch (error) {
    if (
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel)
    ) {
      return new Map();
    }
    throw error;
  }
}

/**
 * What the template posts now: uploaded images carry fresh links (the preview message is refetched for links that
 * expire within `REFRESH_MARGIN_MS`), and the time of posting is filled when the template shows it. Null if the
 * template doesn't exist.
 */
export async function render(ctx: TemplatesContext, id: string): Promise<TemplateMessage | null> {
  const loaded = await ctx.db.run(async (tx) => {
    const [template] = await tx.select().from(templates).where(eq(templates.id, id));
    if (template === undefined) return null;
    const images = await tx.select().from(templateImages).where(eq(templateImages.templateId, id));
    return { template, images };
  });
  if (loaded === null) return null;
  const { template } = loaded;

  const urls = new Map<ImageSlot, string>();
  const stale: TemplateImage[] = [];
  for (const image of loaded.images) {
    if (image.expiresAt.getTime() - Date.now() <= REFRESH_MARGIN_MS) stale.push(image);
    else urls.set(image.slot, image.url);
  }

  if (stale.length > 0) {
    const links = await currentLinks(ctx, template.threadId, template.previewMessageId);
    const renewed: { slot: ImageSlot; url: string; expiresAt: Date }[] = [];
    for (const image of stale) {
      const url = links.get(image.attachmentId);
      if (url === undefined) {
        ctx.log.warn({ templateId: id, slot: image.slot, attachmentId: image.attachmentId }, 'Template image is gone from its preview message');
        continue;
      }
      // A link without a readable expiry is stored as already due, so the next render fetches again.
      renewed.push({ slot: image.slot, url, expiresAt: linkExpiry(url) ?? new Date() });
      urls.set(image.slot, url);
    }
    if (renewed.length > 0) {
      await ctx.db.run(async (tx) => {
        for (const { slot, url, expiresAt } of renewed) {
          await tx
            .update(templateImages)
            .set({ url, expiresAt })
            .where(and(eq(templateImages.templateId, id), eq(templateImages.slot, slot)));
        }
      });
    }
  }

  const embed = template.embed === null ? null : structuredClone(template.embed);
  if (embed !== null) {
    // An upload shows only where the embed names its file (`attachment://<name>`) and the stored link is that file;
    // anything else (an upload still on its way, a gone attachment) is left out rather than passed on.
    for (const slot of IMAGE_SLOTS) {
      const reference = slotUrl(embed, slot);
      const url = urls.get(slot);
      if (reference?.startsWith(UPLOAD_PREFIX) !== true) {
        if (url !== undefined) ctx.log.warn({ templateId: id, slot }, 'Template image is not referenced by its embed');
        continue;
      }
      if (url === undefined || linkFileName(url) !== reference.slice(UPLOAD_PREFIX.length)) {
        ctx.log.warn({ templateId: id, slot }, 'Template image has no stored upload; leaving it out');
        clearSlot(embed, slot);
      } else if (!setSlot(embed, slot, url)) {
        ctx.log.warn({ templateId: id, slot }, 'Template icon has no author name or footer text to attach to');
        clearSlot(embed, slot);
      }
    }
    if (embed.author !== undefined && !embed.author.name) delete embed.author;
    if (embed.footer !== undefined && !embed.footer.text) delete embed.footer;
    if (template.showPostTime) embed.timestamp = new Date().toISOString();
  }
  return { content: template.content, embed };
}
