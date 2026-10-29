import { UserError, isUnknownChannel } from '@bronto/core';
import { ChannelType, DiscordAPIError, OverwriteType, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { FormsContext } from './context.js';
import { forums } from './db/schema.js';

export const FORUM_NAME = 'forms';
const COMMUNITY_MESSAGE = 'Forum channels need a Community server. Turn on Community in Server Settings first.';

/** The stored forms forum's channel ID, or null when the server has none. */
export async function storedForumId(ctx: FormsContext): Promise<string | null> {
  const [row] = await ctx.db.run(async (tx) => tx.select({ id: forums.forumChannelId }).from(forums));
  return row?.id ?? null;
}

/** Whether the channel still exists on Discord; only Unknown Channel counts as gone. */
export async function channelExists(ctx: FormsContext, channelId: string): Promise<boolean> {
  try {
    await ctx.client.channels.fetch(channelId, { force: true });
    return true;
  } catch (error) {
    if (isUnknownChannel(error)) return false;
    throw error;
  }
}

/** The stored forms forum while it exists; otherwise creates one hidden from @everyone and stores it. */
export async function ensureForum(ctx: FormsContext): Promise<string> {
  const stored = await storedForumId(ctx);
  if (stored !== null && (await channelExists(ctx, stored))) return stored;

  const guild = await ctx.client.guilds.fetch(ctx.guildId);
  if (!guild.features.includes('COMMUNITY')) throw new UserError(COMMUNITY_MESSAGE);
  let forum;
  try {
    forum = await guild.channels.create({
      name: FORUM_NAME,
      type: ChannelType.GuildForum,
      permissionOverwrites: [
        // The @everyone role's ID is the server's ID.
        { id: ctx.guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: ctx.client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] },
      ],
    });
  } catch (error) {
    // Discord's answer when a forum is created outside a Community server.
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotExecuteActionOnThisChannelType) {
      throw new UserError(COMMUNITY_MESSAGE);
    }
    throw error;
  }
  await ctx.db.run(async (tx) => {
    await tx
      .insert(forums)
      .values({ forumChannelId: forum.id })
      .onConflictDoUpdate({ target: forums.guildId, set: { forumChannelId: forum.id } });
  });
  return forum.id;
}
