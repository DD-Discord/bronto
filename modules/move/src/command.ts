import { defineCommand, opt, UserError, type CommandDefinition } from '@bronto/core';
import sticky from '@bronto/sticky';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import { classify, type StayReason } from './classify.js';
import type { MoveButtons } from './buttons.js';
import { checkPermissions } from './permissions.js';
import type { PendingMoves } from './pending.js';
import { parseMessageLink, readRange } from './range.js';

const TARGET_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

const STAY_TEXT: Record<StayReason, string> = {
  'too-large': 'with too-large attachments',
  embeds: 'with too many embeds',
  poll: 'polls',
  thread: 'with a thread',
  'forum-start': 'forum post starters',
  interactive: 'interactive',
};

const link = (guildId: string, channelId: string, messageId: string): string => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

function readLink(text: string, name: string, guildId: string): NonNullable<ReturnType<typeof parseMessageLink>> {
  const parsed = parseMessageLink(text);
  if (parsed === null) throw new UserError(`\`${name}\` isn't a link to a message in a server.`);
  if (parsed.guildId !== guildId) throw new UserError(`\`${name}\` links to another server.`);
  return parsed;
}

/** True for a forum or media channel's post, whose starter message stays behind. */
export function isForumPost(channel: GuildTextBasedChannel): boolean {
  return channel.isThread() && [ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.parent?.type as ChannelType);
}

/**
 * Fetches the source and target afresh and checks both members' permissions. Throws a `UserError` when a channel is
 * gone, unsuitable or permissions are missing.
 */
export async function loadChannels(
  client: Client,
  guildId: string,
  sourceId: string,
  targetId: string,
  userId: string,
): Promise<{ guild: Guild; source: GuildTextBasedChannel; target: GuildTextBasedChannel }> {
  const guild = await client.guilds.fetch(guildId);
  const source = await guild.channels.fetch(sourceId).catch(() => null);
  if (source === null || !source.isTextBased()) throw new UserError("I can't find that channel, or it has no messages to move.");
  // Messages in an archived thread can't be deleted, so a move would only copy them.
  if (source.isThread() && source.archived === true) throw new UserError('The messages are in an archived thread. Unarchive the thread first.');
  const target = await guild.channels.fetch(targetId).catch(() => null);
  if (target === null || !target.isTextBased() || !TARGET_TYPES.includes(target.type)) {
    throw new UserError("Messages can't be moved there. Choose a text channel, an announcement channel or a thread.");
  }
  // Threads inherit permissions from their parent, which may not be cached yet.
  for (const channel of [source, target]) if (channel.isThread() && channel.parentId !== null) await guild.channels.fetch(channel.parentId);
  // Roles may have changed since a member was cached, so both are read afresh.
  const [moderator, me] = await Promise.all([guild.members.fetch({ user: userId, force: true }), guild.members.fetchMe({ force: true })]);
  const refused = await checkPermissions(source, target, moderator, me);
  if (refused.length > 0) throw new UserError(`Missing permissions:\n${refused.map((name) => `- ${name}`).join('\n')}`);
  return { guild, source, target };
}

/** The counts of the confirmation: messages that move, and those that stay behind by reason. */
function summarize(plans: ReturnType<typeof classify>[]): string[] {
  const reposts = plans.filter((plan) => plan.kind === 'repost');
  const moving = reposts.filter((plan) => plan.stays.length === 0).length;
  const staying = reposts.filter((plan) => plan.stays.length > 0);
  const lines = [`**${moving}** ${moving === 1 ? 'message' : 'messages'} will move.`];
  if (staying.length > 0) {
    const reasons = (Object.keys(STAY_TEXT) as StayReason[])
      .map((reason) => [reason, staying.filter((plan) => plan.stays.includes(reason)).length] as const)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${STAY_TEXT[reason]}`);
    lines.push(`${staying.length} stay behind: ${reasons.join(', ')}.`);
  }
  return lines;
}

export function createMoveCommand(deps: { pending: PendingMoves; buttons: MoveButtons }): CommandDefinition {
  return defineCommand({
    description: 'Moves messages to another channel or thread',
    permissions: PermissionFlagsBits.ManageMessages,
    ephemeral: true,
    options: {
      from: opt.string({ description: 'Link to the first message to move', required: true }),
      to: opt.string({ description: 'Link to the last message to move (default: only the first)' }),
      target: opt.channel({ description: 'Where the messages go', channelTypes: TARGET_TYPES, required: true }),
    },
    execute: async (ctx, options) => {
      const from = readLink(options.from, 'from', ctx.guildId);
      const to = options.to === null ? null : readLink(options.to, 'to', ctx.guildId);
      if (to !== null && to.channelId !== from.channelId) throw new UserError('Both links must point to the same channel.');
      if (options.target.id === from.channelId) throw new UserError('The messages are already in that channel.');

      const { source, target } = await loadChannels(ctx.client, ctx.guildId, from.channelId, options.target.id, ctx.interaction.user.id);
      const messages = await readRange(source, from.messageId, to?.messageId ?? null);
      const uploadLimit = ctx.interaction.attachmentSizeLimit;
      const stickyApi = ctx.modules.optional(sticky);
      const sourceIsForumPost = isForumPost(source);
      const plans = messages.map((message: Message) =>
        classify(message, { uploadLimit, sourceIsForumPost, isSticky: (m) => stickyApi?.isSticky(m) === true }),
      );

      const token = deps.pending.create({
        guildId: ctx.guildId,
        userId: ctx.interaction.user.id,
        sourceId: source.id,
        targetId: target.id,
        fromId: from.messageId,
        toId: to?.messageId ?? null,
        uploadLimit,
        createdAt: Date.now(),
      });
      const first = link(ctx.guildId, source.id, messages[0]!.id);
      const last = link(ctx.guildId, source.id, messages[messages.length - 1]!.id);
      const lines = [
        `Move messages from <#${source.id}> to <#${target.id}>?`,
        messages.length === 1 ? `Message: ${first}` : `First: ${first}\nLast: ${last}`,
        ...summarize(plans),
      ];
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ctx.customId(deps.buttons.confirm, [token])).setLabel('Move').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(ctx.customId(deps.buttons.cancel, [token])).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await ctx.reply({ content: lines.join('\n'), components: [row], flags: MessageFlags.SuppressEmbeds });
    },
  });
}
