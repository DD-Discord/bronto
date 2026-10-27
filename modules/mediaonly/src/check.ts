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
  author: { bot: boolean };
  member: { permissionsIn(channelId: string): { has(permission: bigint): boolean } } | null;
  attachments: { values(): Iterable<{ spoiler: boolean }> };
}

/**
 * The rule a message breaks and why, or null when the module leaves it alone. In memory only, so the API and the
 * enforcer always agree, whichever listener runs first.
 */
export function rejection(
  ctx: Pick<HandlerContext, 'guildId' | 'modules'>,
  index: RuleIndex,
  message: CheckedMessage,
): { rule: Rule; problem: MediaProblem } | null {
  const rule = index.get(ctx.guildId, message.channelId);
  if (rule === undefined || !rule.enabled || message.system) return null;
  if (rule.ignoreBots && (message.author.bot || message.webhookId !== null)) return null;
  if (ctx.modules.optional(sticky)?.isSticky(message) === true) return null;
  if (message.member?.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages) === true) return null;
  const problem = mediaProblem({ content: message.content, attachments: [...message.attachments.values()] }, rule.requireSpoiler);
  return problem === null ? null : { rule, problem };
}
