import type { ChannelRuleIndex, HandlerContext } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import templates, { fillPlaceholders, postPlaceholders } from '@bronto/templates';
import { Routes, type APIChannel, type Message } from 'discord.js';
import type { Rule } from './db/schema.js';
import type { Rename } from './rename.js';

const MAX_NAME_LENGTH = 100;
const FALLBACK_NAME = 'Comments';

/** The thread name for a format: placeholders filled, trimmed, cut to Discord's 100 characters; `Comments` if blank. */
export function threadName(format: string, values: Readonly<Record<string, string>>): string {
  const name = [...fillPlaceholders(format, values).trim()].slice(0, MAX_NAME_LENGTH).join('').trim();
  return name === '' ? FALLBACK_NAME : name;
}

/** Starts a thread on each post of a rule's channel. */
export class Threader {
  private readonly index: ChannelRuleIndex<Rule>;

  private readonly rename: Rename;

  constructor(deps: { index: ChannelRuleIndex<Rule>; rename: Rename }) {
    this.index = deps.index;
    this.rename = deps.rename;
  }

  async onMessage(ctx: HandlerContext, message: Message): Promise<void> {
    const rule = this.index.get(ctx.guildId, message.channelId);
    if (rule === undefined || !rule.enabled || message.system) return;
    const { author, webhookId } = message;
    if (author.id === ctx.client.user?.id) return;
    if (rule.ignoreBots && (author.bot || webhookId !== null)) return;
    if (ctx.modules.optional(sticky)?.isSticky(message) === true) return;
    // The post is deleted, or about to be; mediaonly's answer doesn't depend on whether its listener ran yet.
    if (ctx.modules.optional(mediaonly)?.rejects(message) === true) return;

    const values = postPlaceholders(message);
    let thread: APIChannel;
    try {
      thread = (await ctx.client.rest.post(Routes.threads(message.channelId, message.id), {
        body: {
          name: threadName(rule.nameFormat, values),
          ...(rule.slowmodeSeconds > 0 ? { rate_limit_per_user: rule.slowmodeSeconds } : {}),
        },
      })) as APIChannel;
    } catch (error) {
      ctx.log.warn({ err: error, channelId: message.channelId, messageId: message.id }, 'Starting a thread failed');
      return;
    }
    await this.postAutoMessage(ctx, rule, thread.id, message, values);
  }

  /**
   * Posts the template in the thread (only the post's author can be pinged by it), with the rename button when the rule
   * has one. Without a template, or when it is gone, the button is posted alone.
   */
  private async postAutoMessage(
    ctx: HandlerContext,
    rule: Rule,
    threadId: string,
    message: Message,
    values: Record<string, string>,
  ): Promise<void> {
    const { templateId } = rule;
    if (templateId === null && !rule.rename) return;
    try {
      let rendered: Awaited<ReturnType<ReturnType<typeof ctx.modules.get<typeof templates>>['render']>> = null;
      if (templateId !== null) {
        rendered = await ctx.modules.get(templates).render(templateId, values);
        if (rendered === null) ctx.log.warn({ channelId: message.channelId, templateId }, 'The auto-message template no longer exists');
      }
      const components = rule.rename ? [this.rename.renameRow(ctx, message.author.id)] : [];
      if (rendered !== null) {
        await ctx.client.rest.post(Routes.channelMessages(threadId), {
          body: {
            content: rendered.content,
            embeds: rendered.embed === null ? [] : [rendered.embed],
            components,
            allowed_mentions: { users: [message.author.id] },
          },
        });
      } else if (rule.rename) {
        await ctx.client.rest.post(Routes.channelMessages(threadId), {
          body: { content: 'The author of this post can rename the thread.', components, allowed_mentions: { parse: [] } },
        });
      }
    } catch (error) {
      ctx.log.warn({ err: error, threadId, templateId }, 'Posting the auto-message failed');
    }
  }
}
