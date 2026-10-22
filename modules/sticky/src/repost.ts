import { ensureWebhook, resolveWebhook, withWebhookErrors, UnknownMessageError, UnknownWebhookError, type IncomingWebhook, type HandlerContext } from '@bronto/core';
import templates from '@bronto/templates';
import { DiscordAPIError, RESTJSONErrorCodes, MessageFlags, type APIEmbed } from 'discord.js';
import { and, asc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
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

/** What a sticky posts. */
export interface StickyMessage {
  content: string;
  embeds: APIEmbed[];
}

/**
 * The sticky's template as it is now; a sticky whose template is missing falls back to the copy it stored before it
 * used templates. Null when there is neither. Called outside any transaction, since the templates API reads on its own.
 */
async function messageOf(ctx: StickyContext, sticky: Sticky): Promise<StickyMessage | null> {
  const rendered = await ctx.modules.get(templates).render(sticky.templateId);
  if (rendered !== null) return { content: rendered.content, embeds: rendered.embed === null ? [] : [rendered.embed] };
  if (sticky.content === null && sticky.embeds === null) return null;
  return { content: sticky.content ?? '', embeds: sticky.embeds ?? [] };
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
  /** Channels with a repost queued that hasn't started; a template refresh queued behind it may replace it. */
  private readonly repostWanted = new Set<string>();

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
    this.repostWanted.add(channelId);
    return ctx.queue.run(channelId, (task) => this.repost(task, channelId));
  }

  /** Brings the live posts of the stickies using a template up to date with it. */
  async refreshTemplate(ctx: StickyContext, templateId: string): Promise<void> {
    const rows = await ctx.db.run(async (tx) =>
      tx.select({ channelId: stickies.channelId }).from(stickies).where(eq(stickies.templateId, templateId)),
    );
    await Promise.all(
      rows
        .filter(({ channelId }) => this.index.get(channelId) !== undefined)
        .map(({ channelId }) => ctx.queue.run(channelId, (task) => this.refresh(task, channelId))),
    );
  }

  /** Deletes the stickies using a template, one at a time so a webhook they share goes with the last of them. */
  async deleteForTemplate(ctx: StickyContext, templateId: string): Promise<void> {
    const rows = await ctx.db.run(async (tx) => tx.select().from(stickies).where(eq(stickies.templateId, templateId)));
    for (const record of rows) await this.deleteForGoneTemplate(ctx, record);
  }

  /**
   * Deletes the stickies without a stored copy whose template no longer exists, e.g. because it was deleted while
   * sticky was switched off. Only a template the API reports missing counts; a failed lookup keeps the sticky.
   */
  async deleteWithoutTemplate(ctx: StickyContext): Promise<void> {
    const rows = await ctx.db.run(async (tx) =>
      tx
        .select()
        .from(stickies)
        .where(and(isNull(stickies.content), isNull(stickies.embeds)))
        .orderBy(asc(stickies.channelId)),
    );
    for (const record of rows) {
      let template: unknown;
      try {
        template = await ctx.modules.get(templates).get(record.templateId);
      } catch (error) {
        ctx.log.warn({ err: error, channelId: record.channelId, templateId: record.templateId }, "Checking a sticky's template failed");
        continue;
      }
      if (template === null) await this.deleteForGoneTemplate(ctx, record);
    }
  }

  /** Deletes a sticky whose template is gone: its post, its webhook unless shared, then its row. */
  private async deleteForGoneTemplate(ctx: StickyContext, record: Sticky): Promise<void> {
    await this.deleteSticky(ctx, record);
    await ctx.db.run(async (tx) => {
      await tx.delete(stickies).where(eq(stickies.channelId, record.channelId));
    });
    ctx.log.info({ channelId: record.channelId, templateId: record.templateId }, 'Deleted a sticky whose template was deleted');
  }

  /**
   * Removes a sticky from the index and deletes its post, and its webhook unless another sticky uses it. The caller
   * deletes the row afterwards.
   */
  async deleteSticky(ctx: StickyContext, record: Sticky): Promise<void> {
    this.index.delete(record.channelId);
    this.cancel(record.channelId);
    // Runs after any repost still in flight, so no post of this sticky is left behind.
    await ctx.queue.run(record.channelId, async (task) => {
      const [current, state] = await task.db.run(async (tx) => {
        const [row] = await tx.select().from(stickies).where(eq(stickies.channelId, record.channelId));
        const [last] = await tx.select().from(stickyState).where(eq(stickyState.channelId, record.channelId));
        return [row, last] as const;
      });
      // A repost that ran meanwhile may have replaced the webhook the caller loaded.
      const sticky = current ?? record;
      if (state?.lastMessageId != null) {
        try {
          await removePost(task, sticky, state.lastMessageId);
        } catch (error) {
          task.log.warn({ err: error, channelId: record.channelId }, 'Deleting the sticky post failed');
        }
      }
      const shared = await task.db.run(async (tx) =>
        tx
          .select({ channelId: stickies.channelId })
          .from(stickies)
          .where(and(eq(stickies.webhookId, sticky.webhookId), ne(stickies.channelId, record.channelId)))
          .limit(1),
      );
      if (shared.length === 0) {
        try {
          await withWebhookErrors(sticky.webhookToken, () => task.client.deleteWebhook(sticky.webhookId, { token: sticky.webhookToken }));
        } catch (error) {
          if (!(error instanceof UnknownWebhookError)) throw error;
        }
      }
    });
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
    this.repostWanted.delete(channelId);
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
    const message = await messageOf(ctx, sticky);
    if (message === null) {
      ctx.log.debug({ channelId, templateId: sticky.templateId }, "Skipped a repost: the sticky's template doesn't exist");
      return;
    }
    try {
      await this.post(ctx, sticky, message, lastMessageId);
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
      await this.post(ctx, { ...sticky, webhookId: replacement.id, webhookToken: replacement.token }, message, null, replacement);
    }
  }

  /**
   * Edits the live post to the sticky's current template; reposts when that post or its webhook is gone, or when a
   * repost this refresh replaced in the queue was still due. A sticky without a post is left for its next repost.
   * Must run inside the channel's queue.
   */
  private async refresh(ctx: StickyContext, channelId: string): Promise<void> {
    if (this.repostWanted.has(channelId)) return this.repost(ctx, channelId);
    const { sticky, lastMessageId } = await ctx.db.run(async (tx) => {
      const [found] = await tx.select().from(stickies).where(eq(stickies.channelId, channelId));
      const [state] = await tx.select().from(stickyState).where(eq(stickyState.channelId, channelId));
      return { sticky: found, lastMessageId: state?.lastMessageId ?? null };
    });
    if (sticky === undefined || lastMessageId === null) return;
    const message = await messageOf(ctx, sticky);
    if (message === null) return;
    try {
      const webhook = await resolveWebhook(ctx.client, { id: sticky.webhookId, token: sticky.webhookToken });
      await withWebhookErrors(sticky.webhookToken, () => webhook.editMessage(lastMessageId, {
        content: message.content, embeds: message.embeds,
        threadId: sticky.parentChannelId === null ? undefined : sticky.channelId,
        allowedMentions: { parse: [] },
      }));
    } catch (error) {
      if (!(error instanceof UnknownMessageError) && !(error instanceof UnknownWebhookError)) throw error;
      await this.repost(ctx, channelId);
    }
  }

  private async post(ctx: StickyContext, sticky: Sticky, message: StickyMessage, lastMessageId: string | null, resolved?: IncomingWebhook): Promise<void> {
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
      content: message.content || undefined, embeds: message.embeds, threadId,
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
