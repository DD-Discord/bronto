import type { HandlerContext } from '@bronto/core';
import sticky from '@bronto/sticky';
import { PermissionFlagsBits } from 'discord.js';
import type { Rule } from './db/schema.js';
import type { RuleIndex } from './rule-index.js';

export type MediaProblem = 'no-media' | 'not-spoilered';

const LINK = /https?:\/\/\S/i;
const SPOILER_SPAN = /\|\|[\s\S]*?\|\|/g;

/**
 * Why a post fails the media check, or null when it passes. A post needs an attachment of any type or an
 * `http(s)://` link; with `requireSpoiler`, every attachment must be a spoiler and every link inside `||…||`.
 */
export function mediaProblem(
  message: { content: string; attachments: { spoiler: boolean }[] },
  requireSpoiler: boolean,
): MediaProblem | null {
  if (message.attachments.length === 0 && !LINK.test(message.content)) return 'no-media';
  if (!requireSpoiler) return null;
  if (message.attachments.some((attachment) => !attachment.spoiler)) return 'not-spoilered';
  return LINK.test(message.content.replace(SPOILER_SPAN, '')) ? 'not-spoilered' : null;
}

/** The parts of a gateway message the check reads. */
export interface CheckedMessage {
  channelId: string;
  content: string;
  system: boolean;
  webhookId: string | null;
  author: { id: string; bot: boolean };
  member: { permissionsIn(channelId: string): { has(permission: bigint): boolean } } | null;
  attachments: { values(): Iterable<{ spoiler: boolean }> };
  /** The content of a forward; the forward itself has no content or attachments. */
  messageSnapshots?: { values(): Iterable<{ content: string; attachments: { values(): Iterable<{ spoiler: boolean }> } }> };
}

/**
 * The rule a message breaks and why, or null when the module leaves it alone. In memory only, so the API and the
 * enforcer always agree, whichever listener runs first. The bot's own posts and reports are never checked, so a log
 * channel covered by a rule can't make the module act on its own reports.
 */
export function rejection(
  ctx: Pick<HandlerContext, 'guildId' | 'modules' | 'client'>,
  index: RuleIndex,
  message: CheckedMessage,
): { rule: Rule; problem: MediaProblem } | null {
  const rule = index.get(ctx.guildId, message.channelId);
  if (rule === undefined || !rule.enabled || message.system) return null;
  const { author, member, webhookId } = message;
  if (author.id === ctx.client.user?.id) return null;
  if (webhookId !== null && index.isLogWebhook(ctx.guildId, webhookId)) return null;
  if (rule.ignoreBots && (author.bot || webhookId !== null)) return null;
  if (ctx.modules.optional(sticky)?.isSticky(message) === true) return null;
  if (member === null) {
    // A person's post without member data: whether they are exempt is unknown.
    if (!author.bot && webhookId === null) return null;
  } else if (member.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages)) {
    return null;
  }
  const snapshots = [...(message.messageSnapshots?.values() ?? [])];
  const problem = mediaProblem(
    {
      content: [message.content, ...snapshots.map((snapshot) => snapshot.content)].join('\n'),
      attachments: [message.attachments, ...snapshots.map((snapshot) => snapshot.attachments)].flatMap((list) => [...list.values()]),
    },
    rule.requireSpoiler,
  );
  return problem === null ? null : { rule, problem };
}
