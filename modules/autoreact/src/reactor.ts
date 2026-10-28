import type { ChannelRuleIndex, HandlerContext } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { Routes, type Message } from 'discord.js';
import type { Rule } from './db/schema.js';

/** The `name:id` or unicode form the reaction route takes. */
function reactionIdentifier(emoji: string): string {
  const custom = /^<a?:(\w+:\d+)>$/.exec(emoji);
  return encodeURIComponent(custom?.[1] ?? emoji);
}

/** Adds a rule's emojis to the posts of its channel. */
export class Reactor {
  private readonly index: ChannelRuleIndex<Rule>;

  constructor(deps: { index: ChannelRuleIndex<Rule> }) {
    this.index = deps.index;
  }

  async onMessage(ctx: HandlerContext, message: Message): Promise<void> {
    const rule = this.index.get(ctx.guildId, message.channelId);
    if (rule === undefined || !rule.enabled || message.system) return;
    const { author, webhookId } = message;
    if (author.id === ctx.client.user?.id) return;
    if (rule.ignoreBots && (author.bot || webhookId !== null)) return;
    if (rule.ignoredUserIds.includes(author.id)) return;
    if (ctx.modules.optional(sticky)?.isSticky(message) === true) return;
    // The post is deleted, or about to be; mediaonly's answer doesn't depend on whether its listener ran yet.
    if (ctx.modules.optional(mediaonly)?.rejects(message) === true) return;

    for (const emoji of rule.emojis) {
      try {
        await ctx.client.rest.put(Routes.channelMessageOwnReaction(message.channelId, message.id, reactionIdentifier(emoji)));
      } catch (error) {
        ctx.log.warn({ err: error, channelId: message.channelId, emoji }, 'Adding a reaction failed');
      }
    }
  }
}
