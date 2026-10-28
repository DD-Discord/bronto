import { deleteMessage, sendDm, sendLogReport, type HandlerContext } from '@bronto/core';
import { eq } from 'drizzle-orm';
import { rejection, type CheckedMessage, type MediaProblem } from './check.js';
import type { MediaonlyConfig } from './config.js';
import { rules, type Rule } from './db/schema.js';
import { dmMessage, noticeText, reportMessage, type ReportNote } from './messages.js';
import type { RuleIndex } from './rule-index.js';

export type MediaonlyContext = HandlerContext<MediaonlyConfig>;

/** How long the notice in the rule channel stays. */
export const NOTICE_MS = 10_000;

/** The parts of a gateway message the enforcer reads. */
export interface IncomingMessage extends CheckedMessage {
  id: string;
  attachments: CheckedMessage['attachments'] & { size: number };
  author: { id: string; bot: boolean; username: string; displayName?: string | null; displayAvatarURL(): string };
  member: (CheckedMessage['member'] & { displayName?: string | null; displayAvatarURL?(): string }) | null;
}

/** Deletes posts that fail the media check, then tells the poster and the rule's log channel. */
export class Enforcer {
  private readonly index: RuleIndex;
  /** Pending notice deletions per guild. */
  private readonly timers = new Map<string, Set<NodeJS.Timeout>>();

  constructor(deps: { index: RuleIndex }) {
    this.index = deps.index;
  }

  async onMessage(ctx: MediaonlyContext, message: IncomingMessage): Promise<void> {
    const found = rejection(ctx, this.index, message);
    if (found === null) return;
    const { rule, problem } = found;
    const { channelId } = message;
    const outcome = await deleteMessage(ctx.client, channelId, message.id);
    if (outcome === 'gone') return;

    const notes: ReportNote[] = [];
    if (outcome === 'forbidden') {
      notes.push('forbidden');
    } else {
      await this.notice(ctx, channelId, message.author.id, problem);
      const dm = await this.dm(ctx, message, problem);
      if (dm === 'closed') notes.push('dmClosed');
      else if (dm === null) notes.push('dmFailed');
    }
    await this.report(ctx, rule, message, problem, notes);
  }

  /** Cancels the pending notice deletions of a guild; those notices stay in their channels. */
  stopGuild(guildId: string): void {
    for (const timer of this.timers.get(guildId) ?? []) clearTimeout(timer);
    this.timers.delete(guildId);
  }

  private async notice(ctx: MediaonlyContext, channelId: string, posterId: string, problem: MediaProblem): Promise<void> {
    let noticeId: string;
    try {
      const channel = await ctx.client.channels.fetch(channelId);
      if (channel === null || !channel.isSendable()) return;
      noticeId = (await channel.send({ content: noticeText(posterId, problem), allowedMentions: { users: [posterId] } })).id;
    } catch (error) {
      ctx.log.warn({ err: error, channelId }, 'Sending the notice failed');
      return;
    }
    const pending = this.timers.get(ctx.guildId) ?? new Set();
    this.timers.set(ctx.guildId, pending);
    const timer = setTimeout(() => {
      pending.delete(timer);
      deleteMessage(ctx.client, channelId, noticeId).then(
        (outcome) => {
          if (outcome !== 'deleted') ctx.log.debug({ channelId, outcome }, 'Deleting the notice failed');
        },
        (error: unknown) => ctx.log.debug({ err: error, channelId }, 'Deleting the notice failed'),
      );
    }, NOTICE_MS);
    timer.unref();
    pending.add(timer);
  }

  /** null when sending failed for another reason than closed DMs. */
  private async dm(ctx: MediaonlyContext, message: IncomingMessage, problem: MediaProblem): Promise<'sent' | 'closed' | null> {
    const dm = dmMessage({ channelId: message.channelId, problem, text: message.content, attachmentCount: message.attachments.size });
    try {
      return await sendDm(ctx.client, message.author.id, dm);
    } catch (error) {
      ctx.log.warn({ err: error, channelId: message.channelId }, 'Sending the DM failed');
      return null;
    }
  }

  private async report(ctx: MediaonlyContext, rule: Rule, message: IncomingMessage, problem: MediaProblem, notes: ReportNote[]): Promise<void> {
    if (rule.logChannelId === null || rule.logWebhookId === null || rule.logWebhookToken === null) return;
    const target = { channelId: rule.logChannelId, threadId: rule.logThreadId, webhookId: rule.logWebhookId, webhookToken: rule.logWebhookToken };
    const { author, member } = message;
    const sender = {
      username: member?.displayName ?? author.displayName ?? author.username,
      avatarUrl: member?.displayAvatarURL?.() ?? author.displayAvatarURL(),
    };
    const report = reportMessage({
      channelId: rule.channelId, posterId: author.id, problem, text: message.content, attachmentCount: message.attachments.size, notes,
    });
    await sendLogReport(ctx, target, report, sender, {
      webhookName: ctx.config.webhookName,
      replaced: async (webhook) => {
        const [updated] = await ctx.db.run(async (tx) =>
          tx
            .update(rules)
            .set({ logWebhookId: webhook.id, logWebhookToken: webhook.token, logThreadId: webhook.threadId })
            .where(eq(rules.channelId, rule.channelId))
            .returning(),
        );
        if (updated !== undefined) this.index.set(updated);
      },
    });
  }
}
