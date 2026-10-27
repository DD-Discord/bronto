import { sendLogReport, type WebhookMessage } from '@bronto/core';
import { eq } from 'drizzle-orm';
import { rules, type Rule } from '../db/schema.js';
import { sendDm, type FetchedPost } from '../discord.js';
import type { AutodeleteContext, MemberInfo, Removal } from '../tracker.js';
import { dmMessage, reportMessage, type ReportKind, type ReportNote } from './messages.js';

async function copyByDm(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, removed: Removal, message: (post: FetchedPost) => WebhookMessage): Promise<boolean | null> {
  if (!rule.notifyDm || removed.post === null || removed.outcome === 'forbidden') return null;
  try { return (await sendDm(ctx.client, member.id, message(removed.post))) === 'sent'; }
  catch (error) { ctx.log.warn({ err: error, channelId: rule.channelId }, 'Sending a copy by DM failed'); return null; }
}

async function report(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, message: WebhookMessage): Promise<void> {
  if (rule.logChannelId === null || rule.logWebhookId === null || rule.logWebhookToken === null) return;
  const target = { channelId: rule.logChannelId, threadId: rule.logThreadId, webhookId: rule.logWebhookId, webhookToken: rule.logWebhookToken };
  await sendLogReport(ctx, target, message, { username: member.displayName, avatarUrl: member.avatarUrl }, {
    webhookName: ctx.config.webhookName,
    replaced: async webhook => {
      await ctx.db.run(async tx => {
        await tx.update(rules).set({ logWebhookId: webhook.id, logWebhookToken: webhook.token, logThreadId: webhook.threadId }).where(eq(rules.channelId, rule.channelId));
      });
    },
  });
}

async function notify(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, kind: ReportKind, removed: Removal, dm: boolean | null, input: { jumpMessageId: string | null; otherText: string | null; nextPostAt?: Date }): Promise<void> {
  const notes: ReportNote[] = [];
  if (removed.post === null || removed.outcome === 'gone') notes.push('gone');
  if (removed.outcome === 'forbidden') notes.push('forbidden');
  if (dm === false) notes.push('dmClosed');
  await report(ctx, rule, member, reportMessage(kind, {
    guildId: ctx.guildId, channelId: rule.channelId, memberId: member.id, jumpMessageId: input.jumpMessageId,
    removedText: removed.post?.content ?? null, removedAttachments: removed.post?.attachmentCount ?? 0,
    otherText: input.otherText, postedAt: removed.postedAt, nextPostAt: input.nextPostAt ?? removed.postedAt,
    joinedAt: member.joinedAt, dmSent: dm === true, notes,
  }));
}

export async function notifyReplaced(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, removed: Removal, newPost: { messageId: string; content: string }): Promise<void> {
  const dm = await copyByDm(ctx, rule, member, removed, post => dmMessage('replaced', {
    guildId: ctx.guildId, channelId: rule.channelId, text: post.content, attachmentCount: post.attachmentCount,
    jumpMessageId: null, cooldownMs: rule.cooldownMs, nextPostAt: removed.postedAt,
  }));
  await notify(ctx, rule, member, 'replaced', removed, dm, { jumpMessageId: newPost.messageId, otherText: newPost.content });
}

export async function notifyRejected(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, rejected: Removal, current: { messageId: string; post: FetchedPost | null } | null, nextPostAt: Date): Promise<void> {
  const dm = await copyByDm(ctx, rule, member, rejected, post => dmMessage('rejected', {
    guildId: ctx.guildId, channelId: rule.channelId, text: post.content, attachmentCount: post.attachmentCount,
    jumpMessageId: current?.messageId ?? null, cooldownMs: rule.cooldownMs, nextPostAt,
  }));
  await notify(ctx, rule, member, 'rejected', rejected, dm, { jumpMessageId: current?.messageId ?? null, otherText: current?.post?.content ?? null, nextPostAt });
}

export async function notifyLeft(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, removed: Removal): Promise<void> {
  await notify(ctx, rule, member, 'left', removed, null, { jumpMessageId: null, otherText: null });
}
