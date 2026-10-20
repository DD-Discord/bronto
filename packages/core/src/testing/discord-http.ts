import { ChannelType, MessageFlags, type APIChannel, type APIEmbed, type APIGuild, type APIMessage, type APIUser, type APIWebhook } from 'discord.js';
import type { WebhookCredentials } from '../webhooks/webhooks.js';
import type { FakeHttpAnswer, FakeRestAnswer, RecordedRequest } from './rest.js';

const error = (code: number, status = 404): FakeRestAnswer => ({ status, json: { code, message: `Synthetic Discord error ${code}` } });
const ok = (json: unknown): FakeRestAnswer => ({ status: 200, json });
const gone = (): FakeRestAnswer => ({ status: 204, json: null });

/** Synthetic resources served over HTTP; production methods never call this fixture service directly. */
export class FakeDiscordHttp {
  readonly botId = '100000000000000090';
  readonly applicationId = '100000000000000091';
  readonly users = new Map<string, APIUser>();
  readonly guilds = new Map<string, APIGuild>();
  readonly channels = new Map<string, APIChannel>();
  readonly messages = new Map<string, APIMessage>();
  readonly webhooks = new Map<string, APIWebhook>();
  private readonly overrides = new Map<string, FakeHttpAnswer>();
  private readonly commands = new Map<string, unknown>();
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
    const channel = this.channels.get(channelId);
    this.webhooks.set(id, { id, token, type: 1, name: 'Synthetic webhook', avatar: null, channel_id: channelId, guild_id: channel && 'guild_id' in channel ? channel.guild_id : this.guildIds[0], application_id: this.applicationId } as APIWebhook);
    return { id, token };
  }
  removeWebhook(id: string): void { this.webhooks.delete(id); }
  liveMessages(channelId?: string): string[] { return [...this.messages.values()].filter(m => channelId === undefined || m.channel_id === channelId).map(m => m.id); }
  override(method: string, path: string, answer: FakeHttpAnswer): void { this.overrides.set(`${method} ${path}`, answer); }

  answer: FakeHttpAnswer = async request => {
    const override = this.overrides.get(`${request.method} ${request.path}`);
    if (override) return override(request);
    const { method, path } = request;
    const parts = path.split('/').filter(Boolean);
    const [resource, id, sub, extra, messageId] = parts;
    if (resource === 'applications' && sub === 'guilds' && messageId === 'commands') {
      if (method === 'GET') return ok(this.commands.get(path) ?? []);
      if (method === 'PUT') { this.commands.set(path, request.body); return ok(request.body); }
    }
    if (resource === 'guilds' && method === 'GET' && parts.length === 2) return this.guilds.has(id!) ? ok(this.guilds.get(id!)) : error(10004);
    if (resource === 'users' && method === 'GET' && parts.length === 2) return this.users.has(id!) ? ok(this.users.get(id!)) : error(10013);
    if (path === '/users/@me/channels' && method === 'POST') {
      const userId = (request.body as { recipient_id: string }).recipient_id;
      if (!this.users.has(userId)) this.addUser(userId);
      const dmId = this.newId();
      const channel = { id: dmId, type: ChannelType.DM, recipients: [this.users.get(userId)!] } as APIChannel;
      this.channels.set(dmId, channel); return ok(channel);
    }
    if (resource === 'channels') {
      const channel = this.channels.get(id!);
      if (!channel) return error(10003);
      if (!sub && method === 'GET') return ok(channel);
      if (sub === 'webhooks' && method === 'POST') { const credentials = this.addWebhook(id!); return ok(this.webhooks.get(credentials.id)); }
      if (sub === 'messages' && extra) {
        const message = this.messages.get(extra);
        if (!message || message.channel_id !== id) return error(10008);
        if (method === 'GET') return ok(message);
        if (method === 'DELETE') { this.messages.delete(extra); return gone(); }
      }
      if (sub === 'messages' && !extra && method === 'POST') return this.send(request, id!);
    }
    if (resource === 'webhooks') {
      const webhook = this.webhooks.get(id!);
      if (!webhook) return error(10015);
      if (sub !== undefined && sub !== webhook.token) return error(50027, 401);
      if (parts.length <= 3) {
        if (method === 'GET') return ok(webhook);
        if (method === 'DELETE') { this.webhooks.delete(id!); return gone(); }
        if (method === 'POST') {
          const threadId = new URLSearchParams(request.query).get('thread_id');
          return this.send(request, threadId ?? webhook.channel_id!, id!);
        }
      }
      if (extra === 'messages' && messageId && method === 'DELETE') {
        const message = this.messages.get(messageId);
        const channelId = new URLSearchParams(request.query).get('thread_id') ?? webhook.channel_id;
        if (!message || message.webhook_id !== id || message.channel_id !== channelId) return error(10008);
        this.messages.delete(messageId); return gone();
      }
    }
    throw new Error(`Unexpected Discord request: ${method} ${path}`);
  };

  private async send(request: RecordedRequest, channelId: string, webhookId?: string): Promise<FakeRestAnswer> {
    const body = request.body instanceof FormData ? JSON.parse(request.body.get('payload_json') as string) : request.body as Record<string, unknown>;
    const id = this.newId();
    this.addMessage(channelId, id, { content: body.content as string ?? '', embeds: body.embeds as APIEmbed[] ?? [], webhookId });
    const message = this.messages.get(id)!;
    Object.assign(message, body, { id, channel_id: channelId, flags: body.flags ?? 0 });
    if (body.components) message.components = body.components as APIMessage['components'];
    return ok(message);
  }
}
