import type { Message } from 'discord.js';
import { ButtonStyle, ComponentType, MessageFlags, MessageType } from 'discord.js';
import { embedStays, fitFiles, messageFiles } from './render.js';

export type StayReason = 'too-large' | 'embeds' | 'poll' | 'thread' | 'forum-start' | 'interactive';
export type Plan = { kind: 'skip-delete' | 'skip-keep' } | { kind: 'repost'; stays: StayReason[] };

/** System messages that stay: a thread's notice in its parent and the starter copy at the top of a thread. */
const KEPT_SYSTEM_TYPES: ReadonlySet<MessageType> = new Set([MessageType.ThreadCreated, MessageType.ThreadStarterMessage]);

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
  if (message.system) return { kind: KEPT_SYSTEM_TYPES.has(message.type) ? 'skip-keep' : 'skip-delete' };
  const stays: StayReason[] = [];
  const fromEmbeds = embedStays(message);
  if (fitFiles(messageFiles(message), ctx.uploadLimit).dropped.length > 0 || fromEmbeds.includes('too-large')) stays.push('too-large');
  if (fromEmbeds.includes('embeds')) stays.push('embeds');
  // A forward's poll or components can't be copied.
  const snapshots = [...message.messageSnapshots.values()];
  if (message.poll !== null || snapshots.some((snapshot) => snapshot.poll !== null)) stays.push('poll');
  if (message.hasThread) stays.push('thread');
  if (ctx.sourceIsForumPost && message.id === message.channelId) stays.push('forum-start');
  const forwardsComponents = snapshots.some((snapshot) => snapshot.components.length > 0 || snapshot.flags.has(MessageFlags.IsComponentsV2));
  if (message.flags.has(MessageFlags.IsComponentsV2) || hasInteractive(message.components) || forwardsComponents || ctx.isSticky(message)) stays.push('interactive');
  return { kind: 'repost', stays };
}
