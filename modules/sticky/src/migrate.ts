import templates from '@bronto/templates';
import { eq, isNotNull } from 'drizzle-orm';
import type { Sticky } from './db/schema.js';
import { stickies } from './db/schema.js';
import type { StickyContext } from './repost.js';

/** The channel's name from the cache or Discord; its ID when it can't be resolved. */
async function channelName(ctx: StickyContext, channelId: string): Promise<string> {
  try {
    const channel = ctx.client.channels.cache.get(channelId) ?? (await ctx.client.channels.fetch(channelId));
    if (channel !== null && 'name' in channel && typeof channel.name === 'string') return channel.name;
  } catch {
    // Falls back to the ID.
  }
  return channelId;
}

async function adopt(ctx: StickyContext, sticky: Sticky): Promise<void> {
  const embeds = sticky.embeds ?? [];
  const name = `Sticky #${await channelName(ctx, sticky.channelId)}`;
  // The row's template ID exists before this call, so a rerun after a crash gets the existing template back.
  await ctx.modules.get(templates).create({ id: sticky.templateId, name, content: sticky.content ?? '', embed: embeds[0] ?? null });
  await ctx.db.run(async (tx) => {
    await tx.update(stickies).set({ content: null, embeds: null }).where(eq(stickies.channelId, sticky.channelId));
  });
  if (embeds.length > 1) ctx.log.info({ channelId: sticky.channelId, dropped: embeds.length - 1 }, 'Dropped extra embeds while moving a sticky to a template');
}

/**
 * Moves stickies that still hold their own copy of a message into templates, one after another (a first create may
 * make the forum). A failure is logged and the sticky keeps posting its copy until the next start.
 */
export async function adoptLegacyStickies(ctx: StickyContext): Promise<void> {
  const rows = await ctx.db.run(async (tx) => tx.select().from(stickies).where(isNotNull(stickies.content)).orderBy(stickies.channelId));
  for (const sticky of rows) {
    try {
      await adopt(ctx, sticky);
    } catch (error) {
      ctx.log.warn({ channelId: sticky.channelId, err: error }, 'Moving a sticky to a template failed; it keeps its stored copy');
    }
  }
}
