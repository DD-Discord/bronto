import type { HandlerContext } from '@bronto/core';
import { eq, isNotNull } from 'drizzle-orm';
import type { StickyConfig } from './config.js';
import { stickies, stickyState, type Sticky } from './db/schema.js';
import {
  UnknownMessageError,
  UnknownWebhookError,
  type PostTarget,
  type StickyDiscord,
  type WebhookCredentials,
} from './discord.js';
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

export function targetOf(sticky: Pick<Sticky, 'channelId' | 'parentChannelId' | 'webhookId' | 'webhookToken'>): PostTarget {
  return {
    id: sticky.webhookId,
    token: sticky.webhookToken,
    threadId: sticky.parentChannelId === null ? null : sticky.channelId,
  };
}

/**
 * Deletes a sticky post through its webhook. A deleted webhook can no longer remove its posts, so the bot removes
 * the post with its own permissions; a post that is already gone counts as done.
 */
export async function removePost(
  discord: StickyDiscord,
  sticky: Pick<Sticky, 'channelId' | 'parentChannelId' | 'webhookId' | 'webhookToken'>,
  messageId: string,
): Promise<void> {
  try {
    await discord.deleteMessage(targetOf(sticky), messageId);
  } catch (error) {
    if (error instanceof UnknownMessageError) return;
    if (!(error instanceof UnknownWebhookError)) throw error;
    await discord.deleteChannelMessage(sticky.channelId, messageId);
  }
}

export interface ReposterOptions {
  index: StickyIndex;
  discord: (ctx: StickyContext) => StickyDiscord;
  now?: () => number;
}

/**
 * Keeps each sticky below the newest message of its channel. Every repost of a channel runs in that channel's queue,
 * so reposts never overlap and a burst of messages ends with exactly one more repost.
 */
export class Reposter {
  private readonly index: StickyIndex;
  private readonly discord: (ctx: StickyContext) => StickyDiscord;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ReposterOptions) {
    this.index = options.index;
    this.discord = options.discord;
    this.now = options.now ?? Date.now;
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
    const repostDueAt = new Date(this.now() + entry.debounceMs);
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
      this.arm(ctx, channelId, Math.max(0, repostDueAt!.getTime() - this.now()));
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
    const discord = this.discord(ctx);
    try {
      await this.post(ctx, discord, sticky, lastMessageId);
    } catch (error) {
      if (!(error instanceof UnknownWebhookError)) throw error;
      const replacement = await this.replaceWebhook(ctx, discord, sticky);
      // Only the deleted webhook could remove its posts; the bot removes the last one with its own permissions.
      if (lastMessageId !== null) {
        try {
          await discord.deleteChannelMessage(channelId, lastMessageId);
        } catch (error) {
          ctx.log.warn({ err: error, channelId }, 'Deleting the previous sticky post failed');
        }
      }
      await this.post(ctx, discord, { ...sticky, webhookId: replacement.id, webhookToken: replacement.token }, null);
    }
  }

  private async post(ctx: StickyContext, discord: StickyDiscord, sticky: Sticky, lastMessageId: string | null): Promise<void> {
    const target = targetOf(sticky);
    if (lastMessageId !== null) {
      try {
        await discord.deleteMessage(target, lastMessageId);
      } catch (error) {
        if (error instanceof UnknownWebhookError) throw error;
        if (!(error instanceof UnknownMessageError)) {
          ctx.log.warn({ err: error, channelId: sticky.channelId }, 'Deleting the previous sticky post failed');
        }
      }
    }
    const messageId = await discord.send(
      target,
      { content: sticky.content, embeds: sticky.embeds },
      { silent: sticky.silent, username: ctx.config.webhookName, avatarUrl: ctx.config.webhookAvatar },
    );
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

  private async replaceWebhook(ctx: StickyContext, discord: StickyDiscord, sticky: Sticky): Promise<WebhookCredentials> {
    const webhook = await discord.ensureWebhook(
      sticky.channelId,
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
