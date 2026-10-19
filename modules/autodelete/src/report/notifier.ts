import { MissingWebhookPermissionError, UnknownWebhookError, type WebhookMessage, type WebhookSendOptions, type WebhookTarget } from '@bronto/core';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { eq } from 'drizzle-orm';
import { rules, type Rule } from '../db/schema.js';
import type { AutodeleteDiscord, FetchedPost } from '../discord.js';
import type { AutodeleteContext, MemberInfo, Notifier, Removal } from '../tracker.js';
import { dmMessage, reportMessage, type ReportKind, type ReportNote } from './messages.js';

/** Discord's limit for a webhook's username. */
const MAX_USERNAME = 80;

/** Discord refuses some webhook usernames (such as ones containing "discord") with Invalid Form Body. */
const isRejectedUsername = (error: unknown): boolean => error instanceof DiscordAPIError && error.code === 50035;

/** Sends once; a rejected username is sent again without it, so the report arrives under the webhook's own name. */
async function sendReport(discord: AutodeleteDiscord, target: WebhookTarget, message: WebhookMessage, options: WebhookSendOptions) {
  try {
    await discord.send(target, message, options);
  } catch (error) {
    if (!isRejectedUsername(error)) throw error;
    await discord.send(target, message, { avatarUrl: options.avatarUrl });
  }
}

/** The log channel is gone or the bot cannot see it. */
const isChannelLost = (error: unknown): boolean =>
  error instanceof DiscordAPIError && (error.code === RESTJSONErrorCodes.UnknownChannel || error.code === RESTJSONErrorCodes.MissingAccess);

/** Notes on how removing a post went, for the report. */
function removalNotes(removed: Removal): ReportNote[] {
  const notes: ReportNote[] = [];
  if (removed.post === null || removed.outcome === 'gone') notes.push('gone');
  if (removed.outcome === 'forbidden') notes.push('forbidden');
  return notes;
}

/** Sends reports through the rule's log webhook and DMs to members. */
export function createNotifier(discordFor: (ctx: AutodeleteContext) => AutodeleteDiscord): Notifier {
  /** A copy of a removed post by DM; false when the member does not take DMs. Null when no DM applies. */
  async function sendDm(
    ctx: AutodeleteContext,
    discord: AutodeleteDiscord,
    rule: Rule,
    member: MemberInfo,
    removed: Removal,
    message: (post: FetchedPost) => WebhookMessage,
  ): Promise<boolean | null> {
    if (!rule.notifyDm || removed.post === null || removed.outcome === 'forbidden') return null;
    try {
      return (await discord.sendDm(member.id, message(removed.post))) === 'sent';
    } catch (error) {
      ctx.log.warn({ err: error, channelId: rule.channelId }, 'Sending a copy by DM failed');
      return null;
    }
  }

  const dropped = (ctx: AutodeleteContext, rule: Rule) =>
    ctx.log.warn({ channelId: rule.logChannelId }, 'Dropped a report: the log channel or webhook is not usable');

  /** Posts the report as the member; a deleted webhook is replaced once. A report that cannot be sent is dropped. */
  async function report(ctx: AutodeleteContext, discord: AutodeleteDiscord, rule: Rule, member: MemberInfo, message: WebhookMessage) {
    if (rule.logChannelId === null || rule.logWebhookId === null || rule.logWebhookToken === null) return;
    const options = { username: Array.from(member.displayName).slice(0, MAX_USERNAME).join(''), avatarUrl: member.avatarUrl };
    const stored = { id: rule.logWebhookId, token: rule.logWebhookToken };
    try {
      await sendReport(discord, { ...stored, threadId: rule.logThreadId }, message, options);
      return;
    } catch (error) {
      if (isChannelLost(error)) return dropped(ctx, rule);
      if (!(error instanceof UnknownWebhookError)) throw error;
    }
    try {
      const webhook = await discord.ensureWebhook(rule.logChannelId, stored, ctx.config.webhookName);
      await ctx.db.run(async (tx) =>
        tx
          .update(rules)
          .set({ logWebhookId: webhook.id, logWebhookToken: webhook.token, logThreadId: webhook.threadId })
          .where(eq(rules.channelId, rule.channelId)),
      );
      await sendReport(discord, webhook, message, options);
    } catch (error) {
      if (error instanceof UnknownWebhookError || error instanceof MissingWebhookPermissionError || isChannelLost(error)) {
        return dropped(ctx, rule);
      }
      throw error;
    }
  }

  async function notify(
    ctx: AutodeleteContext,
    rule: Rule,
    member: MemberInfo,
    kind: ReportKind,
    removed: Removal,
    dm: boolean | null,
    input: { jumpMessageId: string | null; otherText: string | null; nextPostAt?: Date },
  ): Promise<void> {
    const notes = removalNotes(removed);
    if (dm === false) notes.push('dmClosed');
    const message = reportMessage(kind, {
      guildId: ctx.guildId,
      channelId: rule.channelId,
      memberId: member.id,
      jumpMessageId: input.jumpMessageId,
      removedText: removed.post?.content ?? null,
      removedAttachments: removed.post?.attachmentCount ?? 0,
      otherText: input.otherText,
      postedAt: removed.postedAt,
      nextPostAt: input.nextPostAt ?? removed.postedAt,
      joinedAt: member.joinedAt,
      dmSent: dm === true,
      notes,
    });
    await report(ctx, discordFor(ctx), rule, member, message);
  }

  return {
    async replaced(ctx, rule, member, removed, newPost) {
      const dm = await sendDm(ctx, discordFor(ctx), rule, member, removed, (post) =>
        dmMessage('replaced', {
          guildId: ctx.guildId,
          channelId: rule.channelId,
          text: post.content,
          attachmentCount: post.attachmentCount,
          jumpMessageId: null,
          cooldownMs: rule.cooldownMs,
          nextPostAt: removed.postedAt,
        }),
      );
      await notify(ctx, rule, member, 'replaced', removed, dm, { jumpMessageId: newPost.messageId, otherText: newPost.content });
    },

    async rejected(ctx, rule, member, rejected, current, nextPostAt) {
      const dm = await sendDm(ctx, discordFor(ctx), rule, member, rejected, (post) =>
        dmMessage('rejected', {
          guildId: ctx.guildId,
          channelId: rule.channelId,
          text: post.content,
          attachmentCount: post.attachmentCount,
          jumpMessageId: current?.messageId ?? null,
          cooldownMs: rule.cooldownMs,
          nextPostAt,
        }),
      );
      await notify(ctx, rule, member, 'rejected', rejected, dm, {
        jumpMessageId: current?.messageId ?? null,
        otherText: current?.post?.content ?? null,
        nextPostAt,
      });
    },

    async left(ctx, rule, member, removed) {
      await notify(ctx, rule, member, 'left', removed, null, { jumpMessageId: null, otherText: null });
    },
  };
}
