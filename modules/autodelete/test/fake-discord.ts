import { MissingWebhookPermissionError, UnknownWebhookError, type WebhookMessage, type WebhookSendOptions } from '@bronto/core';
import type { AutodeleteDiscord, DeleteOutcome, FetchedPost } from '../src/discord.js';

interface Credentials {
  id: string;
  token: string;
}

interface Target extends Credentials {
  threadId: string | null;
}

interface FakeWebhook {
  channelId: string;
  token: string;
}

/** An in-memory Discord for autodelete tests: webhooks, the posts still in channels, reports and DMs. */
export class FakeAutodeleteDiscord implements AutodeleteDiscord {
  readonly webhooks = new Map<string, FakeWebhook>();
  /** Every call, by method name, in order. */
  readonly calls: string[] = [];
  readonly deletedWebhooks: string[] = [];
  readonly reports: { target: Target; message: WebhookMessage; options: WebhookSendOptions | undefined }[] = [];
  readonly dms: { userId: string; message: WebhookMessage }[] = [];
  readonly deletedPosts: string[] = [];
  missingWebhookPermission = false;
  /** Makes `sendDm` report closed DMs. */
  dmsClosed = false;
  /** Channel IDs that are threads, mapped to their parent. */
  readonly threads = new Map<string, string>();
  private readonly posts = new Map<string, { channelId: string; post: FetchedPost }>();
  private nextId = 100000000000005000n;

  newId(): string {
    this.nextId += 1n;
    return String(this.nextId);
  }

  addWebhook(channelId: string): Credentials {
    const id = this.newId();
    const token = `fake-token-${id}`;
    this.webhooks.set(id, { channelId, token });
    return { id, token };
  }

  addPost(channelId: string, messageId: string, post: FetchedPost = { content: 'Hello', attachmentCount: 0 }): void {
    this.posts.set(messageId, { channelId, post });
  }

  async ensureWebhook(channelId: string, known: Credentials | null, _defaultName: string): Promise<Target> {
    this.calls.push('ensureWebhook');
    if (this.missingWebhookPermission) throw new MissingWebhookPermissionError(channelId);
    const parentId = this.threads.get(channelId);
    const webhookChannelId = parentId ?? channelId;
    const threadId = parentId === undefined ? null : channelId;
    const stored = known === null ? undefined : this.webhooks.get(known.id);
    if (known !== null && stored?.token === known.token && stored.channelId === webhookChannelId) return { ...known, threadId };
    return { ...this.addWebhook(webhookChannelId), threadId };
  }

  async checkWebhook(webhook: Credentials): Promise<{ channelId: string } | null> {
    this.calls.push('checkWebhook');
    const stored = this.webhooks.get(webhook.id);
    return stored?.token === webhook.token ? { channelId: stored.channelId } : null;
  }

  async deleteWebhook(webhook: Credentials): Promise<void> {
    this.calls.push('deleteWebhook');
    if (this.webhooks.get(webhook.id)?.token !== webhook.token) return;
    this.webhooks.delete(webhook.id);
    this.deletedWebhooks.push(webhook.id);
  }

  async send(target: Target, message: WebhookMessage, options?: WebhookSendOptions): Promise<string> {
    this.calls.push('send');
    if (this.webhooks.get(target.id)?.token !== target.token) throw new UnknownWebhookError();
    this.reports.push({ target, message, options });
    return this.newId();
  }

  async fetchPost(_channelId: string, messageId: string): Promise<FetchedPost | null> {
    this.calls.push('fetchPost');
    return this.posts.get(messageId)?.post ?? null;
  }

  async deletePost(channelId: string, messageId: string): Promise<DeleteOutcome> {
    this.calls.push('deletePost');
    if (this.posts.get(messageId)?.channelId !== channelId) return 'gone';
    this.posts.delete(messageId);
    this.deletedPosts.push(messageId);
    return 'deleted';
  }

  async sendDm(userId: string, message: WebhookMessage): Promise<'sent' | 'closed'> {
    this.calls.push('sendDm');
    if (this.dmsClosed) return 'closed';
    this.dms.push({ userId, message });
    return 'sent';
  }
}
