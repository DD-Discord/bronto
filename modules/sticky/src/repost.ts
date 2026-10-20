import { ensureWebhook, resolveWebhook, withWebhookErrors, UnknownMessageError, UnknownWebhookError, type IncomingWebhook, type HandlerContext } from '@bronto/core';
import { DiscordAPIError, RESTJSONErrorCodes, MessageFlags } from 'discord.js';
import { eq, isNotNull } from 'drizzle-orm';
import type { StickyConfig } from './config.js';
import { stickies, stickyState, type Sticky } from './db/schema.js';
import { stickyEvents } from './events.js';
import type { StickyIndex } from './sticky-index.js';

export type StickyContext = HandlerContext<StickyConfig>;

/** The parts of a gateway message the sticky module looks at. */
export interface IncomingMessage {
  channelId: string;
  webhookId: string | null;
  system: boolean;
  author: { bot: boolean };
}

/**
 * Deletes a sticky post through its webhook. A deleted webhook can no longer remove its posts, so the bot removes
 * the post with its own permissions; a post that is already gone counts as done.
 */
export async function removePost(
  ctx: StickyContext,
  sticky: Pick<Sticky, 'channelId' | 'parentChannelId' | 'webhookId' | 'webhookToken'>,
  messageId: string,
): Promise<void> {
  try {
    const webhook = await resolveWebhook(ctx.client, { id: sticky.webhookId, token: sticky.webhookToken });
    await withWebhookErrors(sticky.webhookToken, () => webhook.deleteMessage(messageId, sticky.parentChannelId === null ? undefined : sticky.channelId));
  } catch (error) {
    if (error instanceof UnknownMessageError) return;
    if (!(error instanceof UnknownWebhookError)) throw error;
    await deleteChannelPost(ctx, sticky.channelId, messageId);
  }
}

/** A bot-permission fallback for posts whose webhook no longer exists. */
async function deleteChannelPost(ctx: StickyContext, channelId: string, messageId: string): Promise<void> {
  try {
    const channel = await ctx.client.channels.fetch(channelId);
    if (channel?.isTextBased()) await channel.messages.delete(messageId);
  } catch (error) {
    if (!(error instanceof DiscordAPIError) || (error.code !== RESTJSONErrorCodes.UnknownMessage && error.code !== RESTJSONErrorCodes.UnknownChannel)) throw error;
  }
}

export interface ReposterOptions {
  index: StickyIndex;
}

/**
 * Keeps each sticky below the newest message of its channel. Every repost of a channel runs in that channel's queue,
 * so reposts never overlap and a burst of messages ends with exactly one more repost.
 */
export class Reposter {
  private readonly index: StickyIndex;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ReposterOptions) {
    this.index = options.index;
  }

  /** Reacts to a new message: reposts right away, or (re)starts the channel's debounce. */
  async onMessage(ctx: StickyContext, message: IncomingMessage): Promise<void> {
    const entry = this.index.get(message.channelId);
    if (entry === undefined || entry.guildId !== ctx.guildId) return;
    // The sticky's own posts come from its webhook.
    if (message.webhookId !== null && message.webhookId === entry.webhookId) return;
    if (entry.ignoreBots && (message.author.bot || message.system)) return;
    if (entry.debounceMs === 0) {
      void this.queueRepost(ctx, entry.channelId);
      return;
    }
    const repostDueAt = new Date(Date.now() + entry.debounceMs);
    await ctx.db.run(async (tx) => {
      await tx
        .insert(stickyState)
        .values({ channelId: entry.channelId, repostDueAt })
        .onConflictDoUpdate({ target: stickyState.channelId, set: { repostDueAt } });
    });
    // A delete may have removed the sticky while the due time was written; edits only replace its entry.
    if (this.index.get(entry.channelId) === undefined) return;
    this.arm(ctx, entry.channelId, entry.debounceMs);
  }

  /**
   * Queues a repost behind any work of the channel; resolves when it (or a newer request) finished.
   * Channels without a sticky in the index are skipped, so a repost never replaces the cleanup of a deleted sticky.
   */
  queueRepost(ctx: StickyContext, channelId: string): Promise<void> {
    if (this.index.get(channelId) === undefined) return Promise.resolve();
    return ctx.queue.run(channelId, (task) => this.repost(task, channelId));
  }

  /** Re-arms the guild's pending debounces after start-up or a switch back on; overdue ones post right away. */
  async resume(ctx: StickyContext): Promise<void> {
    const pending = await ctx.db.run(async (tx) =>
      tx
        .select({ channelId: stickyState.channelId, repostDueAt: stickyState.repostDueAt })
        .from(stickyState)
        .where(isNotNull(stickyState.repostDueAt)),
    );
    for (const { channelId, repostDueAt } of pending) {
      this.arm(ctx, channelId, Math.max(0, repostDueAt!.getTime() - Date.now()));
    }
  }

  cancel(channelId: string): void {
    clearTimeout(this.timers.get(channelId));
    this.timers.delete(channelId);
  }

  /** Deletes the previous post, sends a new one and records it. Must run inside the channel's queue. */
  async repost(ctx: StickyContext, channelId: string): Promise<void> {
    const { sticky, lastMessageId } = await ctx.db.run(async (tx) => {
      const [found] = await tx.select().from(stickies).where(eq(stickies.channelId, channelId));
      const [state] = await tx.select().from(stickyState).where(eq(stickyState.channelId, channelId));
      // This repost is the one a pending debounce asked for.
      if (state?.repostDueAt != null) {
        await tx.update(stickyState).set({ repostDueAt: null }).where(eq(stickyState.channelId, channelId));
      }
      return { sticky: found, lastMessageId: state?.lastMessageId ?? null };
    });
    if (sticky === undefined) return;
    try {
      await this.post(ctx, sticky, lastMessageId);
    } catch (error) {
      if (!(error instanceof UnknownWebhookError)) throw error;
      const replacement = await this.replaceWebhook(ctx, sticky);
      // Only the deleted webhook could remove its posts; the bot removes the last one with its own permissions.
      if (lastMessageId !== null) {
        try {
          await deleteChannelPost(ctx, channelId, lastMessageId);
        } catch (error) {
          ctx.log.warn({ err: error, channelId }, 'Deleting the previous sticky post failed');
        }
      }
      await this.post(ctx, { ...sticky, webhookId: replacement.id, webhookToken: replacement.token }, null, replacement);
    }
  }

  private async post(ctx: StickyContext, sticky: Sticky, lastMessageId: string | null, resolved?: IncomingWebhook): Promise<void> {
    const webhook = resolved ?? await resolveWebhook(ctx.client, { id: sticky.webhookId, token: sticky.webhookToken });
    const threadId = sticky.parentChannelId === null ? undefined : sticky.channelId;
    if (lastMessageId !== null) {
      try {
        await withWebhookErrors(sticky.webhookToken, () => webhook.deleteMessage(lastMessageId, threadId));
      } catch (error) {
        if (error instanceof UnknownWebhookError) throw error;
        if (!(error instanceof UnknownMessageError)) {
          ctx.log.warn({ err: error, channelId: sticky.channelId }, 'Deleting the previous sticky post failed');
        }
      }
    }
    const sent = await withWebhookErrors(sticky.webhookToken, () => webhook.send({
      content: sticky.content || undefined, embeds: sticky.embeds, threadId,
      flags: sticky.silent ? MessageFlags.SuppressNotifications : undefined,
      username: ctx.config.webhookName, avatarURL: ctx.config.webhookAvatar, allowedMentions: { parse: [] },
    }));
    const messageId = sent.id;
    try {
      await ctx.db.run(async (tx) => {
        await tx
          .insert(stickyState)
          .values({ channelId: sticky.channelId, lastMessageId: messageId })
          .onConflictDoUpdate({ target: stickyState.channelId, set: { lastMessageId: messageId } });
      });
    } catch (error) {
      // The post is live but unrecorded, so the next repost cannot delete it; the ID lets someone remove it.
      ctx.log.error({ err: error, channelId: sticky.channelId, messageId }, 'Recording the new sticky post failed');
      throw error;
    }
    ctx.emit(stickyEvents.posted, { channelId: sticky.channelId, messageId });
  }

  private async replaceWebhook(ctx: StickyContext, sticky: Sticky): Promise<IncomingWebhook> {
    const { webhook } = await ensureWebhook(
      ctx.client, sticky.channelId,
      { id: sticky.webhookId, token: sticky.webhookToken },
      ctx.config.webhookName,
    );
    await ctx.db.run(async (tx) => {
      await tx
        .update(stickies)
        .set({ webhookId: webhook.id, webhookToken: webhook.token })
        .where(eq(stickies.channelId, sticky.channelId));
    });
    this.index.updateWebhook(sticky.channelId, webhook.id);
    ctx.log.info({ channelId: sticky.channelId }, 'Replaced the deleted webhook of a sticky');
    return webhook;
  }

  private arm(ctx: StickyContext, channelId: string, delayMs: number): void {
    this.cancel(channelId);
    // The timer keeps the ctx that armed it; queue.run starts a new handler run when it fires.
    const timer = setTimeout(() => {
      this.timers.delete(channelId);
      void this.queueRepost(ctx, channelId);
    }, delayMs);
    timer.unref();
    this.timers.set(channelId, timer);
  }
}
