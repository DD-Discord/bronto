import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelType, Guild, Message, MessageFlags } from 'discord.js';
import { createNativeTestClient, type NativeTestClient } from './native-client.js';
import { FakeDiscordHttp } from './discord-http.js';

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000010';
const USER = '100000000000000099';
const MESSAGE = '100000000000000050';
const clients: NativeTestClient[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.client.destroy(); });
async function setup() {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD); http.addUser(USER);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE, { content: 'Synthetic text', authorId: USER });
  const c = await createNativeTestClient(http); clients.push(c);
  return { ...c, http };
}
it('constructs native guilds, channels and messages without opening the gateway', async () => {
  const { client } = await setup();
  expect(client.guilds.cache.get(GUILD)).toBeInstanceOf(Guild);
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error('Missing test channel');
  const message = await channel.messages.fetch(MESSAGE);
  expect(message).toBeInstanceOf(Message);
  expect(message.content).toBe('Synthetic text');
  const connected = vi.spyOn(client.ws, 'connect');
  await client.login('synthetic-token');
  expect(connected).not.toHaveBeenCalled();
});
it('serves native webhook sends and user DMs through one fake transport', async () => {
  const { http, client, requests } = await setup();
  const credentials = http.addWebhook(CHANNEL);
  const webhook = await client.fetchWebhook(credentials.id, credentials.token);
  const sent = await webhook.send({ content: 'Webhook text', allowedMentions: { parse: [] } });
  const dm = await client.users.send(USER, { content: 'Private text', allowedMentions: { parse: [] } });
  expect(sent).toBeInstanceOf(Message); expect(dm).toBeInstanceOf(Message);
  expect(http.messages.get(sent.id)?.content).toBe('Webhook text');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(3);
});
it('records multipart and waits for an asynchronous response', async () => {
  const { http, client, requests } = await setup();
  const credentials = http.addWebhook(CHANNEL);
  const gate = Promise.withResolvers<void>();
  http.override('GET', `/webhooks/${credentials.id}/${credentials.token}`, async () => { await gate.promise; return { status: 200, json: http.webhooks.get(credentials.id) }; });
  const fetching = client.fetchWebhook(credentials.id, credentials.token);
  gate.resolve(); const webhook = await fetching;
  await webhook.send({ content: 'File', files: [{ attachment: Buffer.from('file bytes'), name: 'synthetic.txt' }], flags: MessageFlags.SuppressNotifications });
  const form = requests.at(-1)!.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect(JSON.parse(form.get('payload_json') as string).content).toBe('File');
  expect(await (form.get('files[0]') as Blob).text()).toBe('file bytes');
});
it('rejects unexpected requests locally and records native command registration', async () => {
  const { client, requests } = await setup();
  await expect(client.rest.get('/unconfigured')).rejects.toThrow('GET /unconfigured');
  const route = `/applications/${client.application!.id}/guilds/${GUILD}/commands` as const;
  await client.rest.put(route, { body: [{ name: 'synthetic' }] });
  expect(await client.rest.get(route)).toEqual([{ name: 'synthetic' }]);
  expect(requests.at(-1)!.path).toBe(route);
});

it('blocks native URL downloads and restores the previous dispatcher after the last client', async () => {
  const undici = createRequire(import.meta.resolve('discord.js'))('undici');
  const previous = undici.getGlobalDispatcher();
  let externalCalls = 0;
  const sentinel = {
    dispatch(_options: unknown, handler: { onError(error: Error): void }) {
      externalCalls += 1;
      handler.onError(new Error('Synthetic external dispatcher must not be reached'));
      return false;
    },
  };
  undici.setGlobalDispatcher(sentinel);
  let first: Awaited<ReturnType<typeof setup>> | undefined;
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    first = await setup(); second = await setup();
    const credentials = first.http.addWebhook(CHANNEL);
    const webhook = await first.client.fetchWebhook(credentials.id, credentials.token);
    const before = first.requests.length;
    const error = await webhook.send({ files: ['https://cdn.discordapp.com/synthetic-test-file.txt'] }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(externalCalls).toBe(0);
    expect(first.requests).toHaveLength(before);
    await first.client.destroy();
    expect(undici.getGlobalDispatcher()).not.toBe(sentinel);
    await second.client.destroy();
    expect(undici.getGlobalDispatcher()).toBe(sentinel);
  } finally {
    await first?.client.destroy(); await second?.client.destroy();
    undici.setGlobalDispatcher(previous);
  }
});

it('serves stored attachments from the fake CDN to global fetch and keeps every other host blocked', async () => {
  const { http, client } = await setup();
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isSendable()) throw new Error('Missing test channel');
  const sent = await channel.send({ content: 'File', files: [{ attachment: Buffer.from('file bytes'), name: 'my file.txt' }] });
  const attachment = sent.attachments.first()!;
  const response = await fetch(attachment.url);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/plain');
  expect(await response.text()).toBe('file bytes');
  expect((await fetch(`https://cdn.discordapp.com/attachments/${CHANNEL}/${attachment.id}/other.txt`)).status).toBe(404);
  const seeded = http.addFile(CHANNEL, { filename: 'seed.bin', data: Buffer.from([1, 2, 3]) });
  expect(new Uint8Array(await (await fetch(seeded.url)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  await expect(fetch('https://example.com')).rejects.toThrow();
  await expect(fetch('https://cdn.discordapp.com/other/path')).rejects.toThrow();
});

it('refuses expired CDN urls', async () => {
  const { client } = await setup();
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isSendable()) throw new Error('Missing test channel');
  const sent = await channel.send({ files: [{ attachment: Buffer.from('x'), name: 'x.txt' }] });
  const url = new URL(sent.attachments.first()!.url);
  url.searchParams.set('ex', '1');
  expect((await fetch(url)).status).toBe(404);
});
