import type { Message } from 'discord.js';
import { ButtonStyle, ComponentType, MessageFlags, MessageType } from 'discord.js';
import { fitFiles, messageFiles } from './render.js';

export type StayReason = 'too-large' | 'poll' | 'thread' | 'forum-start' | 'interactive';
export type Plan = { kind: 'skip-delete' | 'skip-keep' } | { kind: 'repost'; stays: StayReason[] };

/** True when the tree holds anything but action rows and link buttons. */
function hasInteractive(components: unknown[]): boolean {
  return components.some((component) => {
    const raw = (typeof (component as { toJSON?: unknown }).toJSON === 'function' ? (component as { toJSON(): unknown }).toJSON() : component) as {
      type: number;
      style?: number;
      components?: unknown[];
    };
    if (raw.type === ComponentType.ActionRow) return hasInteractive(raw.components ?? []);
    return !(raw.type === ComponentType.Button && raw.style === ButtonStyle.Link);
  });
}

/** Decides whether a message is reposted, skipped, and what it leaves behind. */
export function classify(
  message: Message,
  ctx: { uploadLimit: number; sourceIsForumPost: boolean; isSticky: (message: Message) => boolean },
): Plan {
  if (message.system) return { kind: message.type === MessageType.ThreadCreated ? 'skip-keep' : 'skip-delete' };
  const stays: StayReason[] = [];
  if (fitFiles(messageFiles(message), ctx.uploadLimit).dropped.length > 0) stays.push('too-large');
  if (message.poll !== null) stays.push('poll');
  if (message.hasThread) stays.push('thread');
  if (ctx.sourceIsForumPost && message.id === message.channelId) stays.push('forum-start');
  if (message.flags.has(MessageFlags.IsComponentsV2) || hasInteractive(message.components) || ctx.isSticky(message)) stays.push('interactive');
  return { kind: 'repost', stays };
}
