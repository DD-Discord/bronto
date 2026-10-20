import { FakeDiscordHttp, createNativeTestClient } from '@bronto/core/testing';
import { ChannelType, EmbedType, type Client } from 'discord.js';
import { afterEach, expect, it } from 'vitest';
import { fetchTemplate } from '../src/discord.js';
const GUILD = '100000000000000001', OTHER = '100000000000000002', CHANNEL = '100000000000000020', MESSAGE = '100000000000000021';
const clients: Client[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.destroy(); });
async function setup() {
  const http = new FakeDiscordHttp(); http.addGuild(GUILD); http.addGuild(OTHER);
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE, { content: 'Old', embeds: [{ type: EmbedType.Rich, title: 'Rules' }] });
  const c = await createNativeTestClient(http); clients.push(c.client); return { http, ...c };
}
it('refreshes cached template text and filters received embed fields', async () => {
  const { http, client } = await setup();
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error('Missing fixture channel');
  await channel.messages.fetch(MESSAGE);
  http.addMessage(CHANNEL, MESSAGE, { content: 'Updated', embeds: [{ type: EmbedType.Rich, title: 'Rules' }] });
  expect(await fetchTemplate(client, GUILD, CHANNEL, MESSAGE)).toEqual({ content: 'Updated', embeds: [{ title: 'Rules' }] });
});
it('rejects an actual cross-guild channel without reading its message', async () => {
  const { http, client, requests } = await setup();
  await fetchTemplate(client, GUILD, CHANNEL, MESSAGE);
  http.addChannel(CHANNEL, { guildId: OTHER, type: ChannelType.GuildText });
  const count = requests.filter(r => r.path.includes('/messages/')).length;
  await expect(fetchTemplate(client, GUILD, CHANNEL, MESSAGE)).rejects.toThrow('it is not in this server.');
  expect(requests.filter(r => r.path.includes('/messages/'))).toHaveLength(count);
});
it('explains missing and inaccessible templates', async () => {
  const { http, client } = await setup();
  await expect(fetchTemplate(client, GUILD, CHANNEL, '100000000000000404')).rejects.toThrow('it does not exist.');
  http.override('GET', `/channels/${CHANNEL}`, () => ({ status: 403, json: { code: 50001, message: 'Missing Access' } }));
  await expect(fetchTemplate(client, GUILD, CHANNEL, MESSAGE)).rejects.toThrow('I cannot see its channel.');
});
