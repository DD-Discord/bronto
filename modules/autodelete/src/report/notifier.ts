import { ensureWebhook, resolveWebhook, withWebhookErrors, MissingWebhookPermissionError, UnknownWebhookError, type IncomingWebhook, type WebhookMessage, type WebhookSendOptions, type WebhookTarget } from '@bronto/core';
import { DiscordAPIError, RESTJSONErrorCodes, type Client, type WebhookMessageCreateOptions } from 'discord.js';
import { eq } from 'drizzle-orm';
import { rules, type Rule } from '../db/schema.js';
import { sendDm, type FetchedPost } from '../discord.js';
import type { AutodeleteContext, MemberInfo, Removal } from '../tracker.js';
import { dmMessage, reportMessage, type ReportKind, type ReportNote } from './messages.js';

const MAX_USERNAME = 80;
const isChannelLost = (error: unknown): boolean => error instanceof DiscordAPIError &&
  (error.code === RESTJSONErrorCodes.UnknownChannel || error.code === RESTJSONErrorCodes.MissingAccess);

/** A rejected sender name is retried once under the webhook's own name. */
async function sendReport(client: Client, target: WebhookTarget, message: WebhookMessage, options: WebhookSendOptions, resolved?: IncomingWebhook): Promise<void> {
  const webhook = resolved ?? await resolveWebhook(client, target);
  const payload: WebhookMessageCreateOptions = {
    content: message.content, embeds: message.embeds, components: message.components,
    flags: message.flags as WebhookMessageCreateOptions['flags'], withComponents: true,
    allowedMentions: message.allowedMentions ?? { parse: [] }, threadId: target.threadId ?? undefined,
    files: message.files?.map(file => ({ name: file.name, attachment: file.data })),
    username: options.username, avatarURL: options.avatarUrl,
  };
  try { await withWebhookErrors(target.token, () => webhook.send(payload)); }
  catch (error) {
    if (!(error instanceof DiscordAPIError) || error.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType) throw error;
    await withWebhookErrors(target.token, () => webhook.send({ ...payload, username: undefined }));
  }
}

async function copyByDm(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, removed: Removal, message: (post: FetchedPost) => WebhookMessage): Promise<boolean | null> {
  if (!rule.notifyDm || removed.post === null || removed.outcome === 'forbidden') return null;
  try { return (await sendDm(ctx.client, member.id, message(removed.post))) === 'sent'; }
  catch (error) { ctx.log.warn({ err: error, channelId: rule.channelId }, 'Sending a copy by DM failed'); return null; }
}

const dropped = (ctx: AutodeleteContext, rule: Rule) => ctx.log.warn({ channelId: rule.logChannelId }, 'Dropped a report: the log channel or webhook is not usable');

async function report(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, message: WebhookMessage): Promise<void> {
  if (rule.logChannelId === null || rule.logWebhookId === null || rule.logWebhookToken === null) return;
  const options = { username: Array.from(member.displayName).slice(0, MAX_USERNAME).join(''), avatarUrl: member.avatarUrl };
  const stored = { id: rule.logWebhookId, token: rule.logWebhookToken };
  try {
    await sendReport(ctx.client, { ...stored, threadId: rule.logThreadId }, message, options);
    return;
  } catch (error) {
    if (isChannelLost(error)) return dropped(ctx, rule);
    if (!(error instanceof UnknownWebhookError)) throw error;
  }
  try {
    const { webhook, threadId } = await ensureWebhook(ctx.client, rule.logChannelId, stored, ctx.config.webhookName);
    await ctx.db.run(async tx => {
      await tx.update(rules).set({ logWebhookId: webhook.id, logWebhookToken: webhook.token, logThreadId: threadId }).where(eq(rules.channelId, rule.channelId));
    });
    await sendReport(ctx.client, { id: webhook.id, token: webhook.token, threadId }, message, options, webhook);
  } catch (error) {
    if (error instanceof UnknownWebhookError || error instanceof MissingWebhookPermissionError || isChannelLost(error)) return dropped(ctx, rule);
    throw error;
  }
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
