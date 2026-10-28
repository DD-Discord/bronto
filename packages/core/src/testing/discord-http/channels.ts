import { ChannelType, type APIChannel } from 'discord.js';
import { isThread, readPayload, storeUploads } from './messages.js';
import { route } from './router.js';
import { error, ok } from './responses.js';
import type { DiscordState } from './state.js';

type Fields = Record<string, unknown>;
const THREAD_METADATA = ['archived', 'locked', 'auto_archive_duration'] as const;
const CHANNEL_FIELDS = ['name', 'topic', 'parent_id', 'position', 'nsfw', 'permission_overwrites', 'applied_tags', 'default_auto_archive_duration'];

/** Gives tags without an id one, as Discord does when a forum's tag list is saved. */
function withTagIds(state: DiscordState, tags: Fields[]): Fields[] {
  return tags.map(tag => ({ moderated: false, emoji_id: null, emoji_name: null, ...tag, id: tag.id ?? state.newId() }));
}

function updateChannel(state: DiscordState, channel: APIChannel, fields: Fields): void {
  const target = channel as unknown as Fields;
  for (const key of CHANNEL_FIELDS) if (fields[key] !== undefined) target[key] = fields[key];
  if (Array.isArray(fields.available_tags)) target.available_tags = withTagIds(state, fields.available_tags as Fields[]);
  const metadata = target.thread_metadata as Fields | undefined;
  if (metadata) {
    for (const key of THREAD_METADATA) if (fields[key] !== undefined) metadata[key] = fields[key];
    if (fields.archived !== undefined) metadata.archive_timestamp = new Date().toISOString();
  }
}

export function channelRoutes(state: DiscordState) {
  function remove(id: string): void {
    for (const [childId, child] of state.channels) if ('parent_id' in child && child.parent_id === id) remove(childId);
    for (const [messageId, message] of state.messages) {
      if (message.channel_id !== id) continue;
      for (const attachment of message.attachments) state.files.delete(attachment.id);
      state.messages.delete(messageId);
    }
    state.channels.delete(id);
    state.deletedChannels.push(id);
  }

  return [
    route('GET', '/channels/:channelId', (_request, { channelId }) => {
      const channel = state.channels.get(channelId);
      return channel ? ok(channel) : error(10003);
    }),
    route('PATCH', '/channels/:channelId', (request, { channelId }) => {
      const channel = state.channels.get(channelId);
      if (!channel) return error(10003);
      updateChannel(state, channel, (request.body ?? {}) as Fields);
      return ok(channel);
    }),
    route('DELETE', '/channels/:channelId', (_request, { channelId }) => {
      const channel = state.channels.get(channelId);
      if (!channel) return error(10003);
      remove(channelId);
      return ok(channel);
    }),
    route('GET', '/guilds/:guildId/channels', (_request, { guildId }) => {
      if (!state.guilds.has(guildId)) return error(10004);
      return ok([...state.channels.values()].filter(c => 'guild_id' in c && c.guild_id === guildId && !isThread(c.type)));
    }),
    route('POST', '/guilds/:guildId/channels', (request, { guildId }) => {
      const guild = state.guilds.get(guildId);
      if (!guild) return error(10004);
      const body = (request.body ?? {}) as Fields;
      const type = (body.type as ChannelType | undefined) ?? ChannelType.GuildText;
      if ((type === ChannelType.GuildForum || type === ChannelType.GuildMedia) && !guild.features.includes('COMMUNITY' as never)) {
        return error(50024, 400);
      }
      const id = state.newId();
      state.addChannel(id, { guildId, type, parentId: body.parent_id as string | undefined, name: String(body.name) });
      const channel = state.channels.get(id)!;
      updateChannel(state, channel, body);
      return ok(channel);
    }),
    // A thread started on a message takes the message's ID and its parent's kind (public or announcement).
    route('POST', '/channels/:channelId/messages/:messageId/threads', async (request, { channelId, messageId }) => {
      const parent = state.channels.get(channelId);
      if (!parent || !('guild_id' in parent) || !parent.guild_id) return error(10003);
      const message = state.messages.get(messageId);
      if (!message || message.channel_id !== channelId) return error(10008);
      if (state.channels.has(messageId)) return error(160004, 400);
      const body = (request.body ?? {}) as Fields;
      state.addChannel(messageId, {
        guildId: parent.guild_id, parentId: channelId, name: String(body.name),
        type: parent.type === ChannelType.GuildAnnouncement ? ChannelType.AnnouncementThread : ChannelType.PublicThread,
        extra: { rate_limit_per_user: body.rate_limit_per_user ?? 0, message_count: 0, total_message_sent: 0, member_count: 1 },
      });
      const thread = state.channels.get(messageId)!;
      updateChannel(state, thread, { auto_archive_duration: body.auto_archive_duration });
      return ok(thread);
    }),
    route('POST', '/channels/:channelId/threads', async (request, { channelId }) => {
      const parent = state.channels.get(channelId);
      if (!parent || !('guild_id' in parent) || !parent.guild_id) return error(10003);
      const { body, files } = await readPayload(request);
      const forum = parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia;
      const starter = body.message as Fields | undefined;
      if (forum !== (starter !== undefined)) {
        return { status: 400, json: { code: 50035, message: 'Invalid Form Body', errors: {} } };
      }
      const id = state.newId();
      state.addChannel(id, {
        guildId: parent.guild_id, parentId: channelId, name: String(body.name),
        type: forum ? ChannelType.PublicThread : (body.type as ChannelType | undefined) ?? ChannelType.PublicThread,
        extra: { applied_tags: body.applied_tags ?? [], message_count: starter ? 1 : 0, total_message_sent: starter ? 1 : 0, member_count: 1 },
      });
      const thread = state.channels.get(id)!;
      updateChannel(state, thread, { auto_archive_duration: body.auto_archive_duration });
      if (!starter) return ok(thread);

      state.addMessage(id, id, { content: starter.content as string ?? '', embeds: starter.embeds as never ?? [] });
      const message = state.messages.get(id)!;
      const { attachments: _, ...fields } = starter;
      Object.assign(message, fields, { flags: starter.flags ?? 0 });
      message.attachments = storeUploads(state, id, starter, files, true);
      return ok({ ...thread, message: state.present(message) });
    }),
  ];
}
