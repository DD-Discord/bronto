import type { StickyMessage } from '../src/message.js';
import {
  MissingWebhookPermissionError,
  TemplateUnavailableError,
  UnknownMessageError,
  UnknownWebhookError,
  type ChannelInfo,
  type PostOptions,
  type PostTarget,
  type StickyDiscord,
  type WebhookCredentials,
} from '../src/discord.js';

interface FakeWebhook {
  channelId: string;
  token: string;
  owned: boolean;
}

interface FakePost {
  id: string;
  webhookId: string;
  channelId: string;
  threadId: string | null;
  message: StickyMessage;
  options: PostOptions;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-memory Discord for sticky tests: webhooks, templates, channels and the posts still in each channel. */
export class FakeStickyDiscord implements StickyDiscord {
  readonly webhooks = new Map<string, FakeWebhook>();
  readonly sent: FakePost[] = [];
  readonly deleted: string[] = [];
  readonly botDeleted: string[] = [];
  readonly deletedWebhooks: string[] = [];
  /** Every call, by method name, in order. */
  readonly calls: string[] = [];
  sendDelayMs = 0;
  missingWebhookPermission = false;
  /** Whether findWebhookToken reveals tokens of webhooks this application does not own. */
  tokensVisible = true;
  private readonly live = new Map<string, FakePost>();
  private readonly templates = new Map<string, { guildId: string; message: StickyMessage }>();
  private readonly channels = new Map<string, ChannelInfo>();
  private nextId = 100000000000005000n;

  newId(): string {
    this.nextId += 1n;
    return String(this.nextId);
  }

  addWebhook(channelId: string, options: { owned?: boolean } = {}): WebhookCredentials {
    const id = this.newId();
    const token = `fake-token-${id}`;
    this.webhooks.set(id, { channelId, token, owned: options.owned ?? true });
    return { id, token };
  }

  removeWebhook(id: string): void {
    this.webhooks.delete(id);
  }

  addTemplate(guildId: string, channelId: string, messageId: string, message: StickyMessage): void {
    this.templates.set(`${channelId}/${messageId}`, { guildId, message });
  }

  addChannel(channelId: string, info: ChannelInfo): void {
    this.channels.set(channelId, info);
  }

  /** Posts still in Discord, optionally of one channel or thread. */
  liveMessages(channelId?: string): string[] {
    return [...this.live.values()]
      .filter((post) => channelId === undefined || (post.threadId ?? post.channelId) === channelId)
      .map((post) => post.id);
  }

  async fetchTemplate(guildId: string, channelId: string, messageId: string): Promise<StickyMessage> {
    this.calls.push('fetchTemplate');
    const template = this.templates.get(`${channelId}/${messageId}`);
    if (template === undefined) throw new TemplateUnavailableError('it does not exist.');
    if (template.guildId !== guildId) throw new TemplateUnavailableError('it is not in this server.');
    return template.message;
  }

  async ensureWebhook(channelId: string, name: string): Promise<WebhookCredentials> {
    this.calls.push('ensureWebhook');
    if (this.missingWebhookPermission) throw new MissingWebhookPermissionError(channelId);
    for (const [id, webhook] of this.webhooks) {
      if (webhook.channelId === channelId && webhook.owned) return { id, token: webhook.token };
    }
    return this.createWebhook(channelId, name);
  }

  async createWebhook(channelId: string, _name: string): Promise<WebhookCredentials> {
    this.calls.push('createWebhook');
    if (this.missingWebhookPermission) throw new MissingWebhookPermissionError(channelId);
    return this.addWebhook(channelId);
  }

  async findWebhookToken(channelId: string, webhookId: string): Promise<string | null> {
    this.calls.push('findWebhookToken');
    if (this.missingWebhookPermission) throw new MissingWebhookPermissionError(channelId);
    const webhook = this.webhooks.get(webhookId);
    if (webhook === undefined || webhook.channelId !== channelId) return null;
    return webhook.owned || this.tokensVisible ? webhook.token : null;
  }

  async deleteWebhook(webhook: WebhookCredentials): Promise<void> {
    this.calls.push('deleteWebhook');
    if (this.webhooks.get(webhook.id)?.token !== webhook.token) return;
    this.webhooks.delete(webhook.id);
    this.deletedWebhooks.push(webhook.id);
  }

  async deleteWebhookById(webhookId: string): Promise<void> {
    this.calls.push('deleteWebhookById');
    if (!this.webhooks.delete(webhookId)) return;
    this.deletedWebhooks.push(webhookId);
  }

  async channelInfo(channelId: string): Promise<ChannelInfo | null> {
    this.calls.push('channelInfo');
    return this.channels.get(channelId) ?? null;
  }

  async send(target: PostTarget, message: StickyMessage, options: PostOptions): Promise<string> {
    this.calls.push('send');
    this.requireWebhook(target);
    if (this.sendDelayMs > 0) await sleep(this.sendDelayMs);
    const webhook = this.requireWebhook(target);
    const post: FakePost = { id: this.newId(), webhookId: target.id, channelId: webhook.channelId, threadId: target.threadId, message, options };
    this.sent.push(post);
    this.live.set(post.id, post);
    return post.id;
  }

  async deleteMessage(target: PostTarget, messageId: string): Promise<void> {
    this.calls.push('deleteMessage');
    this.requireWebhook(target);
    const post = this.live.get(messageId);
    if (post === undefined || post.webhookId !== target.id) throw new UnknownMessageError();
    this.live.delete(messageId);
    this.deleted.push(messageId);
  }

  async deleteChannelMessage(_channelId: string, messageId: string): Promise<void> {
    this.calls.push('deleteChannelMessage');
    if (this.live.delete(messageId)) this.botDeleted.push(messageId);
  }

  private requireWebhook(target: PostTarget): FakeWebhook {
    const webhook = this.webhooks.get(target.id);
    if (webhook === undefined || webhook.token !== target.token) throw new UnknownWebhookError();
    return webhook;
  }
}
