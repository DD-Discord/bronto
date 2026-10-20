import { afterEach, expect, it } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import { FakeDiscordHttp, createNativeTestClient } from '../testing/index.js';
import { resolveWebhook, ensureWebhook } from './native.js';
import { UnknownWebhookError, MissingWebhookPermissionError, withWebhookErrors } from './errors.js';
const GUILD = '100000000000000001', CHANNEL = '100000000000000010', THREAD = '100000000000000011';
const clients: Client[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.destroy(); });
async function setup() {
  const http = new FakeDiscordHttp(); http.addGuild(GUILD);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  const c = await createNativeTestClient(http); clients.push(c.client);
  return { http, ...c };
}
it('reuses only a known webhook on the target channel', async () => {
  const { http, client } = await setup();
  const known = http.addWebhook(CHANNEL);
  expect((await ensureWebhook(client, CHANNEL, known, 'Sticky')).webhook.id).toBe(known.id);
  const other = http.addWebhook('100000000000000012');
  expect((await ensureWebhook(client, CHANNEL, other, 'Sticky')).webhook.id).not.toBe(other.id);
});
it.each([10015, 50027])('replaces unusable webhook %i during native fetch', async code => {
  const { http, client } = await setup(); const known = http.addWebhook(CHANNEL);
  http.override('GET', `/webhooks/${known.id}/${known.token}`, () => ({ status: code === 50027 ? 401 : 404, json: { code, message: 'Unusable webhook' } }));
  await expect(resolveWebhook(client, known)).rejects.toBeInstanceOf(UnknownWebhookError);
  expect((await ensureWebhook(client, CHANNEL, known, 'Sticky')).webhook.id).not.toBe(known.id);
});
it.each([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread])('routes thread %i through its parent', async type => {
  const { http, client } = await setup(); http.addChannel(THREAD, { guildId: GUILD, type, parentId: CHANNEL });
  const result = await ensureWebhook(client, THREAD, null, 'Sticky');
  expect(result.threadId).toBe(THREAD); expect(result.webhook.channelId).toBe(CHANNEL); expect(result.webhook.client).toBe(client);
});
it('maps missing create permission and uses the same REST manager for sends and deletes', async () => {
  const { http, client, requests } = await setup();
  const known = http.addWebhook(CHANNEL); const webhook = await resolveWebhook(client, known);
  const message = await withWebhookErrors(known.token, () => webhook.send({ content: 'Synthetic', allowedMentions: { parse: [] } }));
  await withWebhookErrors(known.token, () => webhook.deleteMessage(message.id));
  expect(requests.slice(-2).map(r => r.authorized)).toEqual([false, false]);
  http.override('POST', `/channels/${CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
  await expect(ensureWebhook(client, CHANNEL, null, 'Sticky')).rejects.toMatchObject({ name: 'MissingWebhookPermissionError', channelId: CHANNEL });
});
