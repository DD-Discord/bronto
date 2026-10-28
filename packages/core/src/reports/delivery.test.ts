import { ChannelType, type Client } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { captureLog, createNativeTestClient, FakeDiscordHttp } from '../testing/index.js';
import { deleteMessage, sendDm, sendLogReport, type LogTarget } from './delivery.js';

const GUILD = '100000000000000001', CHANNEL = '100000000000000010', LOG_CHANNEL = '100000000000000020';
const MESSAGE = '100000000000000050', USER = '100000000000000099';
const clients: Client[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.destroy(); });

async function setup() {
  const http = new FakeDiscordHttp(); http.addGuild(GUILD); http.addUser(USER);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addChannel(LOG_CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE, { content: 'Old', attachmentCount: 0 });
  const c = await createNativeTestClient(http); clients.push(c.client);
  return { http, ...c };
}

describe('sendDm', () => {
  it('sends files and reports closed DMs', async () => {
    const { http, client, requests } = await setup();
    expect(await sendDm(client, USER, { content: 'Hello', files: [{ name: 'post.txt', data: Buffer.from('x') }] })).toBe('sent');
    expect(((requests.at(-1)!.body as FormData).get('files[0]') as File).name).toBe('post.txt');
    http.override('POST', '/users/@me/channels', () => ({ status: 403, json: { code: 50007, message: 'Closed' } }));
    client.channels.cache.clear();
    expect(await sendDm(client, USER, { content: 'Hello' })).toBe('closed');
  });

  it('strips the request body from other failures', async () => {
    const { http, client } = await setup();
    http.override('POST', '/users/@me/channels', () => ({ status: 400, json: { code: 50035, message: 'Invalid' } }));
    const error = await sendDm(client, USER, { content: 'synthetic private text' }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('requestBody');
  });
});

describe('deleteMessage', () => {
  it('deletes a message', async () => {
    const { http, client } = await setup();
    expect(await deleteMessage(client, CHANNEL, MESSAGE)).toBe('deleted');
    expect(http.messages.has(MESSAGE)).toBe(false);
  });

  it.each([10008, 10003])('is gone for missing resource %i', async (code) => {
    const { http, client } = await setup();
    http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 404, json: { code, message: 'Gone' } }));
    expect(await deleteMessage(client, CHANNEL, MESSAGE)).toBe('gone');
  });

  it.each([50001, 50013])('is forbidden for permission refusal %i, and rethrows other failures', async (code) => {
    const { http, client } = await setup();
    http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 403, json: { code, message: 'Forbidden' } }));
    expect(await deleteMessage(client, CHANNEL, MESSAGE)).toBe('forbidden');
    http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 400, json: { code: 50035, message: 'Unexpected' } }));
    await expect(deleteMessage(client, CHANNEL, MESSAGE)).rejects.toThrow();
  });
});

describe('sendLogReport', () => {
  const sender = { username: 'Alex', avatarUrl: 'https://cdn.example/alex.png' };
  const message = { content: 'Report' };

  async function withWebhook() {
    const s = await setup();
    const webhook = s.http.addWebhook(LOG_CHANNEL);
    const target: LogTarget = { channelId: LOG_CHANNEL, threadId: null, webhookId: webhook.id, webhookToken: webhook.token };
    const stored: { id: string; token: string; threadId: string | null }[] = [];
    const { log, lines } = captureLog();
    const run = (msg = message, from = sender) => sendLogReport({ client: s.client, log }, target, msg, from, {
      webhookName: 'Reports', replaced: async (w) => { stored.push(w); },
    });
    return { ...s, target, stored, lines, run };
  }

  it('sends under the sender name', async () => {
    const { http, run, stored } = await withWebhook();
    expect(await run()).toBe('sent');
    expect(http.reports[0]!.options).toEqual(sender);
    expect(stored).toEqual([]);
  });

  it('cuts the username to 80 characters', async () => {
    const { http, run } = await withWebhook();
    await run(message, { ...sender, username: 'é'.repeat(100) });
    expect(Array.from(http.reports[0]!.options.username!)).toHaveLength(80);
  });

  it('retries a rejected username without it', async () => {
    const { http, run, target } = await withWebhook();
    const sent: (string | undefined)[] = [];
    const path = `/webhooks/${target.webhookId}/${target.webhookToken}`;
    http.override('POST', path, (request) => {
      const payload = request.body as { username?: string };
      sent.push(payload.username);
      if (payload.username === 'Alex') return { status: 400, json: { code: 50035, message: 'Invalid Form Body' } };
      http.clearOverride('POST', path);
      return http.answer(request);
    });
    expect(await run()).toBe('sent');
    expect(sent).toEqual(['Alex', 'Synthetic webhook']);
  });

  it('recreates an unknown webhook once', async () => {
    const { http, run, target, stored, requests } = await withWebhook();
    http.removeWebhook(target.webhookId);
    expect(await run()).toBe('sent');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(target.webhookId);
    expect(http.reports[0]!.target.id).toBe(stored[0]!.id);
    expect(requests.filter((r) => r.method === 'POST' && r.path === `/channels/${LOG_CHANNEL}/webhooks`)).toHaveLength(1);
  });

  it('drops when the channel is gone', async () => {
    const { http, run, target, lines } = await withWebhook();
    http.override('POST', `/webhooks/${target.webhookId}/${target.webhookToken}`, () => ({ status: 404, json: { code: 10003, message: 'Unknown Channel' } }));
    expect(await run()).toBe('dropped');
    expect(lines.some((line) => line.level === 40)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(target.webhookToken);
  });

  it('drops when the webhook cannot be recreated', async () => {
    const { http, run, target, stored } = await withWebhook();
    http.removeWebhook(target.webhookId);
    http.override('POST', `/channels/${LOG_CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    expect(await run()).toBe('dropped');
    expect(stored).toEqual([]);
  });
});
