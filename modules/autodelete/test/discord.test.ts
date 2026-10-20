import { FakeDiscordHttp, createNativeTestClient } from '@bronto/core/testing';
import { ChannelType, type Client } from 'discord.js';
import { afterEach, expect, it } from 'vitest';
import { fetchPost, deletePost, sendDm } from '../src/discord.js';
const GUILD = '100000000000000001', CHANNEL = '100000000000000010', MESSAGE = '100000000000000050', USER = '100000000000000099';
const clients: Client[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.destroy(); });
async function setup() {
  const http = new FakeDiscordHttp(); http.addGuild(GUILD); http.addUser(USER);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE, { content: 'Old', attachmentCount: 1 });
  const c = await createNativeTestClient(http); clients.push(c.client); return { http, ...c };
}
it('fetches fresh post text and attachment counts instead of a cached message', async () => {
  const { http, client } = await setup();
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error('Missing fixture channel');
  await channel.messages.fetch(MESSAGE);
  http.addMessage(CHANNEL, MESSAGE, { content: 'Updated', attachmentCount: 2 });
  expect(await fetchPost(client, CHANNEL, MESSAGE)).toEqual({ content: 'Updated', attachmentCount: 2 });
});
it.each([10008, 10003])('returns null and gone for missing resource %i', async code => {
  const { http, client } = await setup();
  http.override('GET', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 404, json: { code, message: 'Gone' } }));
  http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 404, json: { code, message: 'Gone' } }));
  expect(await fetchPost(client, CHANNEL, MESSAGE)).toBeNull();
  expect(await deletePost(client, CHANNEL, MESSAGE)).toBe('gone');
});
it.each([50001, 50013])('maps permission refusal %i without swallowing other failures', async code => {
  const { http, client } = await setup();
  http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 403, json: { code, message: 'Forbidden' } }));
  expect(await deletePost(client, CHANNEL, MESSAGE)).toBe('forbidden');
  http.override('DELETE', `/channels/${CHANNEL}/messages/${MESSAGE}`, () => ({ status: 400, json: { code: 50035, message: 'Unexpected' } }));
  await expect(deletePost(client, CHANNEL, MESSAGE)).rejects.toThrow();
});
it('deletes a post with native methods', async () => {
  const { http, client } = await setup();
  expect(await deletePost(client, CHANNEL, MESSAGE)).toBe('deleted'); expect(http.messages.has(MESSAGE)).toBe(false);
});
it('sends native DMs with files, handles closed DMs and strips failed bodies', async () => {
  const { http, client, requests } = await setup();
  expect(await sendDm(client, USER, { content: 'Hello', files: [{ name: 'post.txt', data: Buffer.from('synthetic file') }] })).toBe('sent');
  const form = requests.at(-1)!.body as FormData;
  expect((form.get('files[0]') as File).name).toBe('post.txt');
  http.override('POST', '/users/@me/channels', () => ({ status: 403, json: { code: 50007, message: 'Closed' } }));
  client.channels.cache.clear();
  expect(await sendDm(client, USER, { content: 'Hello' })).toBe('closed');
  http.override('POST', '/users/@me/channels', () => ({ status: 400, json: { code: 50035, message: 'Invalid' } }));
  const error = await sendDm(client, USER, { content: 'synthetic private text' }).catch(e => e);
  expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('requestBody');
});
