import { ChannelType, type MessageFlags, type APIChannel, type APIEmbed, type APIGuild, type APIMessage, type APIUser, type APIWebhook } from 'discord.js';
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
  private readonly templates = new Set<string>();
  private nextId = 100000000000005000n;

  constructor() { this.addUser(this.botId, { bot: true, username: 'Synthetic Bot' }); }
  get guildIds(): string[] { return [...this.guilds.keys()]; }
  newId(): string { return String(++this.nextId); }
  addGuild(id: string): void {
    this.guilds.set(id, { id, name: 'Synthetic guild', unavailable: false, owner_id: '100000000000000099', roles: [], emojis: [], features: [], stickers: [], channels: [], members: [] } as unknown as APIGuild);
  }
  addUser(id: string, options: { bot?: boolean; username?: string } = {}): void {
    this.users.set(id, { id, username: options.username ?? `User ${id.slice(-3)}`, discriminator: '0', global_name: null, avatar: null, bot: options.bot ?? false });
  }
  addChannel(id: string, options: { guildId: string; type: ChannelType; parentId?: string | null }): void {
    this.channels.set(id, { id, guild_id: options.guildId, type: options.type, parent_id: options.parentId ?? null, name: 'synthetic-channel', position: 0, permission_overwrites: [], owner_id: this.botId, thread_metadata: { archived: false, locked: false, auto_archive_duration: 60, archive_timestamp: '2026-01-01T00:00:00Z' } } as APIChannel);
  }
  addMessage(channelId: string, id: string, options: { content?: string; authorId?: string; webhookId?: string | null; embeds?: APIEmbed[]; attachmentCount?: number } = {}): void {
    const authorId = options.authorId ?? this.botId;
    if (!this.users.has(authorId)) this.addUser(authorId);
    this.messages.set(id, { id, channel_id: channelId, author: this.users.get(authorId)!, content: options.content ?? '', timestamp: '2026-03-01T12:00:00Z', edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: Array.from({ length: options.attachmentCount ?? 0 }, (_, i) => ({ id: String(i), filename: 'synthetic.txt', size: 0, url: 'https://example.test/file', proxy_url: 'https://example.test/file' })), embeds: options.embeds ?? [], pinned: false, type: 0, flags: 0 as MessageFlags, ...(options.webhookId ? { webhook_id: options.webhookId } : {}) } as APIMessage);
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
