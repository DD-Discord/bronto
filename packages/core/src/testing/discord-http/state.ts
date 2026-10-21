import { createHash } from 'node:crypto';
import { ChannelType, type MessageFlags, type APIAttachment, type APIChannel, type APIEmbed, type APIGuild, type APIMessage, type APIUser, type APIWebhook } from 'discord.js';
import type { WebhookMessage, WebhookSendOptions, WebhookTarget, WebhookCredentials } from '../../webhooks/types.js';

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
  readonly sent: { id: string; webhookId: string; channelId: string; threadId: string | null; message: { content: string; embeds: APIEmbed[] }; options: { silent: boolean; username?: string; avatarUrl?: string }; startedAt: number }[] = [];
  readonly reports: { target: WebhookTarget; message: WebhookMessage; options: WebhookSendOptions }[] = [];
  readonly dms: { userId: string; message: WebhookMessage }[] = [];
  readonly deleted: string[] = [];
  readonly botDeleted: string[] = [];
  readonly deletedPosts: string[] = [];
  readonly deletedWebhooks: string[] = [];
  readonly deletedChannels: string[] = [];
  /** Bytes behind attachment objects, keyed by attachment id; the fake CDN serves them. */
  readonly files = new Map<string, StoredFile>();
  private signatures = 0;
  private readonly templates = new Set<string>();
  private nextId = 100000000000005000n;

  constructor() { this.addUser(this.botId, { bot: true, username: 'Synthetic Bot' }); }
  get guildIds(): string[] { return [...this.guilds.keys()]; }
  newId(): string { return String(++this.nextId); }
  /** Guilds are communities by default; forum channels exist only in communities. */
  addGuild(id: string, options: { community?: boolean } = {}): void {
    this.guilds.set(id, { id, name: 'Synthetic guild', unavailable: false, owner_id: '100000000000000099', roles: [], emojis: [], features: (options.community ?? true) ? ['COMMUNITY'] : [], stickers: [], channels: [], members: [] } as unknown as APIGuild);
  }
  addUser(id: string, options: { bot?: boolean; username?: string } = {}): void {
    this.users.set(id, { id, username: options.username ?? `User ${id.slice(-3)}`, discriminator: '0', global_name: null, avatar: null, bot: options.bot ?? false });
  }
  addChannel(id: string, options: { guildId: string; type: ChannelType; parentId?: string | null; name?: string; ownerId?: string; archived?: boolean; locked?: boolean; extra?: Record<string, unknown> }): void {
    this.channels.set(id, { id, guild_id: options.guildId, type: options.type, parent_id: options.parentId ?? null, name: options.name ?? 'synthetic-channel', position: 0, permission_overwrites: [], owner_id: options.ownerId ?? this.botId, thread_metadata: { archived: options.archived ?? false, locked: options.locked ?? false, auto_archive_duration: 60, archive_timestamp: '2026-01-01T00:00:00Z' }, ...(options.type === ChannelType.GuildForum ? { available_tags: [], default_auto_archive_duration: 1440, flags: 0 } : {}), ...options.extra } as APIChannel);
  }
  addMessage(channelId: string, id: string, options: { content?: string; authorId?: string; webhookId?: string | null; embeds?: APIEmbed[]; attachmentCount?: number; files?: NewFile[] } = {}): void {
    const authorId = options.authorId ?? this.botId;
    if (!this.users.has(authorId)) this.addUser(authorId);
    this.messages.set(id, { id, channel_id: channelId, author: this.users.get(authorId)!, content: options.content ?? '', timestamp: '2026-03-01T12:00:00Z', edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: Array.from({ length: options.attachmentCount ?? 0 }, (_, i) => ({ id: String(i), filename: 'synthetic.txt', size: 0, url: 'https://example.test/file', proxy_url: 'https://example.test/file' })), embeds: options.embeds ?? [], pinned: false, type: 0, flags: 0 as MessageFlags, ...(options.webhookId ? { webhook_id: options.webhookId } : {}) } as APIMessage);
    for (const file of options.files ?? []) this.messages.get(id)!.attachments.push(this.addFile(channelId, file));
  }
  /** Stores attachment bytes for the fake CDN and returns the attachment object. */
  addFile(channelId: string, file: NewFile): APIAttachment {
    const id = this.newId();
    const data = Buffer.from(file.data as string);
    this.files.set(id, { channelId, filename: file.filename, contentType: file.contentType ?? guessContentType(file.filename), data });
    return this.signAttachment({ id, filename: file.filename, size: data.length, content_type: file.contentType ?? guessContentType(file.filename), url: '', proxy_url: '' } as APIAttachment, channelId);
  }
  /** Signs the URLs of stored attachments afresh, as Discord does whenever a message is served. */
  present<T extends APIMessage>(message: T): T {
    for (const attachment of message.attachments) if (this.files.has(attachment.id)) this.signAttachment(attachment, message.channel_id);
    return message;
  }
  private signAttachment(attachment: APIAttachment, channelId: string): APIAttachment {
    const issued = Math.floor(Date.now() / 1000);
    const expires = (issued + 24 * 3600).toString(16);
    const hm = createHash('sha256').update(`${attachment.id}:${expires}:${++this.signatures}`).digest('hex');
    attachment.url = `https://cdn.discordapp.com/attachments/${channelId}/${attachment.id}/${encodeURIComponent(attachment.filename)}?ex=${expires}&is=${issued.toString(16)}&hm=${hm}`;
    attachment.proxy_url = attachment.url.replace('cdn.discordapp.com', 'media.discordapp.net');
    return attachment;
  }
  addWebhook(channelId: string, credentials?: WebhookCredentials): WebhookCredentials {
    const { id, token } = credentials ?? { id: this.newId(), token: `synthetic-token-${this.nextId}` };
    if (!this.channels.has(channelId)) this.addChannel(channelId, { guildId: this.guildIds[0] ?? '100000000000000001', type: ChannelType.GuildText });
    const channel = this.channels.get(channelId);
    this.webhooks.set(id, { id, token, type: 1, name: 'Synthetic webhook', avatar: null, channel_id: channelId, guild_id: channel && 'guild_id' in channel ? channel.guild_id : this.guildIds[0], application_id: this.applicationId } as APIWebhook);
    return { id, token };
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
