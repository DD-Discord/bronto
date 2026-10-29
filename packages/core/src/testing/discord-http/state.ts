import { createHash } from 'node:crypto';
import { ChannelType, MessageType, PermissionFlagsBits, type MessageFlags, type APIAttachment, type APIChannel, type APIEmbed, type APIGuild, type APIGuildMember, type APIOverwrite, type APIRole, type APIMessage, type APIUser, type APIWebhook } from 'discord.js';
import type { WebhookMessage, WebhookSendOptions, WebhookTarget, WebhookCredentials } from '../../webhooks/types.js';

/** What @everyone may do in a new guild: read and write in channels and threads. */
export const EVERYONE_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.ReadMessageHistory;

/** Resources and fixture builders shared by the HTTP handlers of one fake. */
export class DiscordState {
  readonly botId = '100000000000000090';
  readonly applicationId = '100000000000000091';
  readonly users = new Map<string, APIUser>();
  readonly guilds = new Map<string, APIGuild>();
  readonly channels = new Map<string, APIChannel>();
  readonly messages = new Map<string, APIMessage>();
  readonly webhooks = new Map<string, APIWebhook>();
  readonly commands = new Map<string, unknown>();
  readonly sent: { id: string; webhookId: string; channelId: string; threadId: string | null; message: { content: string; embeds: APIEmbed[] }; options: { silent: boolean; flags: number; allowedMentions: unknown; username?: string; avatarUrl?: string }; files: { name: string; description?: string; size: number }[]; startedAt: number }[] = [];
  readonly reports: { target: WebhookTarget; message: WebhookMessage; options: WebhookSendOptions }[] = [];
  readonly dms: { userId: string; message: WebhookMessage }[] = [];
  readonly deleted: string[] = [];
  /** Webhook messages edited through their webhook, in order. */
  readonly edited: string[] = [];
  readonly botDeleted: string[] = [];
  readonly deletedPosts: string[] = [];
  /** Reactions the bot added, in order; `emoji` is the unicode character or `name:id`. */
  readonly reactions: { messageId: string; emoji: string }[] = [];
  readonly deletedWebhooks: string[] = [];
  readonly deletedChannels: string[] = [];
  /** Bytes behind attachment objects, keyed by attachment id; the fake CDN serves them. */
  readonly files = new Map<string, StoredFile>();
  /** Guild members by `<guildId>:<userId>`. */
  readonly members = new Map<string, APIGuildMember>();
  private signatures = 0;
  private readonly templates = new Set<string>();
  private nextId = 100000000000005000n;

  constructor() { this.addUser(this.botId, { bot: true, username: 'Synthetic Bot' }); }
  get guildIds(): string[] { return [...this.guilds.keys()]; }
  newId(): string { return String(++this.nextId); }
  /** Guilds are communities by default; forum channels exist only in communities. */
  addGuild(id: string, options: { community?: boolean } = {}): void {
    this.guilds.set(id, { id, name: 'Synthetic guild', unavailable: false, owner_id: '100000000000000099', roles: [{ id, name: '@everyone', permissions: String(EVERYONE_PERMISSIONS), position: 0, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 }], emojis: [], features: (options.community ?? true) ? ['COMMUNITY'] : [], stickers: [], channels: [], members: [] } as unknown as APIGuild);
  }
  /** Adds a role; discord.js computes permissions from these, so a guild fetched earlier needs a forced refetch. */
  addRole(guildId: string, role: { id: string; name?: string; permissions?: bigint }): void {
    const guild = this.guilds.get(guildId)!;
    guild.roles.push({ id: role.id, name: role.name ?? 'Synthetic role', permissions: String(role.permissions ?? 0n), position: guild.roles.length, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 } as unknown as APIRole);
  }
  /** Adds a guild member (and the user when unknown) holding the given roles besides @everyone. */
  addMember(guildId: string, userId: string, options: { roles?: string[] } = {}): void {
    if (!this.users.has(userId)) this.addUser(userId);
    this.members.set(`${guildId}:${userId}`, { user: this.users.get(userId)!, roles: options.roles ?? [], joined_at: '2026-01-01T00:00:00Z', deaf: false, mute: false, flags: 0 } as unknown as APIGuildMember);
  }
  addUser(id: string, options: { bot?: boolean; username?: string } = {}): void {
    this.users.set(id, { id, username: options.username ?? `User ${id.slice(-3)}`, discriminator: '0', global_name: null, avatar: null, bot: options.bot ?? false });
  }
  addChannel(id: string, options: { guildId: string; type: ChannelType; parentId?: string | null; name?: string; ownerId?: string; permissionOverwrites?: APIOverwrite[]; archived?: boolean; locked?: boolean; extra?: Record<string, unknown> }): void {
    this.channels.set(id, { id, guild_id: options.guildId, type: options.type, parent_id: options.parentId ?? null, name: options.name ?? 'synthetic-channel', position: 0, permission_overwrites: options.permissionOverwrites ?? [], owner_id: options.ownerId ?? this.botId, thread_metadata: { archived: options.archived ?? false, locked: options.locked ?? false, auto_archive_duration: 60, archive_timestamp: '2026-01-01T00:00:00Z' }, ...(options.type === ChannelType.GuildForum ? { available_tags: [], default_auto_archive_duration: 1440, flags: 0 } : {}), ...options.extra } as APIChannel);
  }
  /**
   * Adds a message. `referenceId` makes it a reply, `snapshots` a forward, `threadId` attaches the thread it started,
   * and `poll` a one-answer poll.
   */
  addMessage(channelId: string, id: string, options: {
    content?: string; authorId?: string; webhookId?: string | null; embeds?: APIEmbed[]; attachmentCount?: number; files?: NewFile[];
    reactions?: { emoji: { id: string | null; name: string }; count: number }[]; referenceId?: string; poll?: boolean;
    stickers?: { id: string; name: string; format: number; guildId?: string }[]; components?: unknown[]; flags?: number;
    type?: MessageType; snapshots?: { content: string; files?: NewFile[] }[]; threadId?: string; timestamp?: string;
  } = {}): void {
    const authorId = options.authorId ?? this.botId;
    if (!this.users.has(authorId)) this.addUser(authorId);
    const timestamp = options.timestamp ?? '2026-03-01T12:00:00Z';
    const message = { id, channel_id: channelId, author: this.users.get(authorId)!, content: options.content ?? '', timestamp, edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: Array.from({ length: options.attachmentCount ?? 0 }, (_, i) => ({ id: String(i), filename: 'synthetic.txt', size: 0, url: 'https://example.test/file', proxy_url: 'https://example.test/file' })), embeds: options.embeds ?? [], pinned: false, type: options.type ?? (options.referenceId ? MessageType.Reply : MessageType.Default), flags: (options.flags ?? 0) as MessageFlags, ...(options.webhookId ? { webhook_id: options.webhookId } : {}) } as APIMessage;
    const extra: Record<string, unknown> = {};
    const guildId = this.guildOf(channelId);
    if (options.reactions) extra.reactions = options.reactions.map(({ emoji, count }) => ({ emoji, count, count_details: { burst: 0, normal: count }, me: false, me_burst: false, burst_colors: [] }));
    if (options.referenceId) extra.message_reference = { type: 0, message_id: options.referenceId, channel_id: channelId, guild_id: guildId };
    if (options.poll) extra.poll = { question: { text: 'Synthetic poll' }, answers: [{ answer_id: 1, poll_media: { text: 'Yes' } }], expiry: null, allow_multiselect: false, layout_type: 1 };
    if (options.stickers) extra.sticker_items = options.stickers.map(({ id: stickerId, name, format, guildId: sticker_guild }) => ({ id: stickerId, name, format_type: format, ...(sticker_guild ? { guild_id: sticker_guild } : {}) }));
    if (options.components) extra.components = options.components;
    if (options.snapshots) {
      extra.message_reference = { type: 1, message_id: this.newId(), channel_id: channelId, guild_id: guildId };
      extra.message_snapshots = options.snapshots.map((snapshot) => ({
        message: { type: MessageType.Default, content: snapshot.content, embeds: [], attachments: (snapshot.files ?? []).map((file) => this.addFile(channelId, file)), timestamp, edited_timestamp: null, flags: 0, mentions: [], mention_roles: [] },
      }));
    }
    if (options.threadId) extra.thread = this.channels.get(options.threadId) ?? { id: options.threadId, guild_id: guildId, parent_id: channelId, type: ChannelType.PublicThread, name: 'synthetic-thread', owner_id: this.botId, thread_metadata: { archived: false, locked: false, auto_archive_duration: 60, archive_timestamp: timestamp } };
    this.messages.set(id, Object.assign(message, extra));
    for (const file of options.files ?? []) message.attachments.push(this.addFile(channelId, file));
  }
  private guildOf(channelId: string): string | undefined {
    const channel = this.channels.get(channelId);
    return channel && 'guild_id' in channel ? channel.guild_id : undefined;
  }
  /** Stores attachment bytes for the fake CDN and returns the attachment object. */
  addFile(channelId: string, file: NewFile): APIAttachment {
    const id = this.newId();
    const data = Buffer.from(file.data as string);
    this.files.set(id, { channelId, filename: file.filename, contentType: file.contentType ?? guessContentType(file.filename), data });
    return this.signAttachment({ id, filename: file.filename, size: data.length, content_type: file.contentType ?? guessContentType(file.filename), url: '', proxy_url: '' } as APIAttachment, channelId);
  }
  /**
   * The message as Discord serves it: attachment URLs signed afresh, and attachments an embed shows through
   * `attachment://<name>` moved out of `attachments` into that embed URL. The stored message keeps the references.
   */
  present<T extends APIMessage>(message: T, withReference = true): T {
    for (const attachment of message.attachments) if (this.files.has(attachment.id)) this.signAttachment(attachment, message.channel_id);
    const shown = new Set<string>();
    const resolve = (url: string | undefined): string | undefined => {
      if (url?.startsWith('attachment://') !== true) return url;
      const attachment = message.attachments.find((entry) => entry.filename === url.slice('attachment://'.length));
      if (attachment === undefined) return url;
      shown.add(attachment.id);
      return attachment.url;
    };
    const embeds = message.embeds.map((embed) => {
      const copy = structuredClone(embed);
      if (copy.image) copy.image.url = resolve(copy.image.url)!;
      if (copy.thumbnail) copy.thumbnail.url = resolve(copy.thumbnail.url)!;
      if (copy.author?.icon_url) copy.author.icon_url = resolve(copy.author.icon_url);
      if (copy.footer?.icon_url) copy.footer.icon_url = resolve(copy.footer.icon_url);
      return copy;
    });
    const reference = message.message_reference;
    const replied = withReference && reference?.type !== 1 && reference?.message_id ? this.messages.get(reference.message_id) : undefined;
    return {
      ...message, embeds, attachments: message.attachments.filter((attachment) => !shown.has(attachment.id)),
      ...(withReference && reference?.type !== 1 && reference?.message_id ? { referenced_message: replied ? this.present(replied, false) : null } : {}),
    };
  }
  private signAttachment(attachment: APIAttachment, channelId: string): APIAttachment {
    const issued = Math.floor(Date.now() / 1000);
    const expires = (issued + 24 * 3600).toString(16);
    const hm = createHash('sha256').update(`${attachment.id}:${expires}:${++this.signatures}`).digest('hex');
    attachment.url = `https://cdn.discordapp.com/attachments/${channelId}/${attachment.id}/${encodeURIComponent(attachment.filename)}?ex=${expires}&is=${issued.toString(16)}&hm=${hm}`;
    attachment.proxy_url = attachment.url.replace('cdn.discordapp.com', 'media.discordapp.net');
    return attachment;
  }
  /** Adds a webhook unless its ID exists already; returns the stored webhook, which carries the credentials. */
  addWebhook(channelId: string, credentials?: WebhookCredentials, options: { applicationId?: string | null; name?: string } = {}): APIWebhook & WebhookCredentials {
    const { id, token } = credentials ?? { id: this.newId(), token: `synthetic-token-${this.nextId}` };
    if (!this.channels.has(channelId)) this.addChannel(channelId, { guildId: this.guildIds[0] ?? '100000000000000001', type: ChannelType.GuildText });
    const channel = this.channels.get(channelId);
    if (!this.webhooks.has(id)) this.webhooks.set(id, { id, token, type: 1, name: options.name ?? 'Synthetic webhook', avatar: null, channel_id: channelId, guild_id: channel && 'guild_id' in channel ? channel.guild_id : this.guildIds[0], application_id: 'applicationId' in options ? options.applicationId : this.applicationId } as APIWebhook);
    return this.webhooks.get(id)! as APIWebhook & WebhookCredentials;
  }
  removeWebhook(id: string): void { this.webhooks.delete(id); }
  liveMessages(channelId?: string): string[] { return [...this.messages.values()].filter(m => !this.templates.has(m.id) && (channelId === undefined || m.channel_id === channelId)).map(m => m.id); }

  addPost(channelId: string, id: string, post: { content: string; attachmentCount: number } = { content: 'Hello', attachmentCount: 0 }): void {
    if (!this.channels.has(channelId)) this.addChannel(channelId, { guildId: this.guildIds[0] ?? '100000000000000001', type: ChannelType.GuildText });
    this.addMessage(channelId, id, post);
  }

  addTemplate(guildId: string, channelId: string, messageId: string, message: { content: string; embeds: APIEmbed[] }): void {
    if (!this.guilds.has(guildId)) this.addGuild(guildId);
    this.addChannel(channelId, { guildId, type: ChannelType.GuildText });
    this.addMessage(channelId, messageId, message);
    this.templates.add(messageId);
  }
}

export interface NewFile { filename: string; data: Buffer | Uint8Array | string; contentType?: string }
export interface StoredFile { channelId: string; filename: string; contentType: string; data: Buffer }

const contentTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', json: 'application/json', md: 'text/markdown',
};
export function guessContentType(filename: string): string {
  return contentTypes[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
