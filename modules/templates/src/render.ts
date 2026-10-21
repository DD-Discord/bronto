import { and, eq } from 'drizzle-orm';
import { DiscordAPIError, RESTJSONErrorCodes, type APIEmbed } from 'discord.js';
import type { TemplatesContext } from './context.js';
import type { TemplateMessage } from './content.js';
import { templateImages, templates, type ImageSlot, type TemplateImage } from './db/schema.js';
import { linkExpiry, REFRESH_MARGIN_MS } from './images.js';

export { REFRESH_MARGIN_MS } from './images.js';

/** Sets the slot's URL, creating the embed part when the template has none. */
function setSlot(embed: APIEmbed, slot: ImageSlot, url: string): void {
  switch (slot) {
    case 'image':
      embed.image = { url };
      break;
    case 'thumbnail':
      embed.thumbnail = { url };
      break;
    case 'author_icon':
      embed.author = { ...embed.author!, icon_url: url };
      break;
    case 'footer_icon':
      embed.footer = { ...embed.footer!, icon_url: url };
      break;
  }
}

/** The preview message's attachment links by attachment ID; empty when the message or thread is gone. */
async function currentLinks(ctx: TemplatesContext, threadId: string, messageId: string): Promise<Map<string, string>> {
  try {
    const channel = await ctx.client.channels.fetch(threadId);
    if (channel === null || !channel.isTextBased()) return new Map();
    const message = await channel.messages.fetch(messageId);
    return new Map(message.attachments.map((attachment) => [attachment.id, attachment.url]));
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
    for (const [slot, url] of urls) setSlot(embed, slot, url);
    if (template.showPostTime) embed.timestamp = new Date().toISOString();
  }
  return { content: template.content, embed };
}
