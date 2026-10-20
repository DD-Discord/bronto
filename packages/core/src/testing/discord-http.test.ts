import { expect, it } from 'vitest';
import { ChannelType } from 'discord.js';
import { FakeDiscordHttp } from './discord-http.js';
const GUILD = '100000000000000001';
const CHANNEL = '100000000000000010';
const OTHER = '100000000000000011';
const MESSAGE = '100000000000000050';
it('keeps fixture authorization and resource errors realistic', async () => {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addChannel(OTHER, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE);
  const webhook = http.addWebhook(CHANNEL);
  const request = (method: string, path: string) => http.answer({ method, path, query: '', body: undefined, authorized: true });
  expect(await request('GET', `/webhooks/${webhook.id}/wrong-token`)).toMatchObject({ status: 401, json: { code: 50027 } });
  expect(await request('GET', '/webhooks/100000000000000404/token')).toMatchObject({ status: 404, json: { code: 10015 } });
  expect(await request('DELETE', `/channels/${OTHER}/messages/${MESSAGE}`)).toMatchObject({ status: 404, json: { code: 10008 } });
  expect(http.messages.has(MESSAGE)).toBe(true);
  http.override('GET', `/channels/${CHANNEL}`, () => ({ status: 403, json: { code: 50001, message: 'Missing Access' } }));
  expect(await request('GET', `/channels/${CHANNEL}`)).toMatchObject({ status: 403, json: { code: 50001 } });
});

// Accepting an unimplemented subresource can hide an unexpected SDK request.
it.each([
  ['GET', `/channels/${CHANNEL}/messages/${MESSAGE}/unexpected`],
  ['GET', `/channels/${CHANNEL}/`],
  ['GET', `/channels//${CHANNEL}`],
  ['POST', `/channels/${CHANNEL}/webhooks/unexpected`],
  ['PUT', '/applications/100000000000000091/guilds/100000000000000001/commands/unexpected'],
])('rejects unsupported routes: %s %s', async (method, path) => {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE);

  await expect(http.answer({ method, path, query: '', body: [], authorized: true }))
    .rejects.toThrow(`Unexpected Discord request: ${method} ${path}`);
  expect(http.webhooks.size).toBe(0);
  expect(http.messages.has(MESSAGE)).toBe(true);
});
