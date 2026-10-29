import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, DiscordAPIError, type ForumChannel, type ThreadChannel } from 'discord.js';
import { FakeDiscordHttp } from './discord-http.js';
import { createNativeTestClient, type NativeTestClient } from './native-client.js';
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

it('records reactions on existing messages only', async () => {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE);
  const request = (path: string) => http.answer({ method: 'PUT', path, query: '', body: undefined, authorized: true });
  expect(await request(`/channels/${CHANNEL}/messages/${MESSAGE}/reactions/${encodeURIComponent('\u{1F44D}')}/@me`)).toMatchObject({ status: 204 });
  expect(await request(`/channels/${CHANNEL}/messages/${MESSAGE}/reactions/${encodeURIComponent('party:100000000000000200')}/@me`)).toMatchObject({ status: 204 });
  expect(http.reactions).toEqual([{ messageId: MESSAGE, emoji: '\u{1F44D}' }, { messageId: MESSAGE, emoji: 'party:100000000000000200' }]);
  expect(await request(`/channels/${CHANNEL}/messages/100000000000000404/reactions/x/@me`)).toMatchObject({ status: 404, json: { code: 10008 } });
});

it('starts a thread on a message once, with the message ID and slowmode', async () => {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addMessage(CHANNEL, MESSAGE);
  const request = (path: string, body?: unknown) => http.answer({ method: 'POST', path, query: '', body, authorized: true });
  const path = `/channels/${CHANNEL}/messages/${MESSAGE}/threads`;
  expect(await request(path, { name: 'Talk', rate_limit_per_user: 30 })).toMatchObject({
    status: 200,
    json: { id: MESSAGE, name: 'Talk', parent_id: CHANNEL, type: ChannelType.PublicThread, rate_limit_per_user: 30 },
  });
  expect(await request(path, { name: 'Again' })).toMatchObject({ status: 400, json: { code: 160004 } });
  expect(await request(`/channels/${CHANNEL}/messages/100000000000000404/threads`, { name: 'x' })).toMatchObject({ status: 404, json: { code: 10008 } });
});

it('edits webhook messages through their webhook only', async () => {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  const webhook = http.addWebhook(CHANNEL);
  const other = http.addWebhook(CHANNEL);
  const request = (method: string, path: string, body?: unknown) => http.answer({ method, path, query: '', body, authorized: false });
  const sent = await request('POST', `/webhooks/${webhook.id}/${webhook.token}`, { content: 'v1' });
  const id = (sent.json as { id: string }).id;
  expect(await request('PATCH', `/webhooks/${other.id}/${other.token}/messages/${id}`, { content: 'nope' })).toMatchObject({ status: 404, json: { code: 10008 } });
  expect(await request('PATCH', `/webhooks/${webhook.id}/${webhook.token}/messages/${id}`, { content: 'v2', embeds: [{ title: 'T' }] }))
    .toMatchObject({ status: 200, json: { content: 'v2', embeds: [{ title: 'T' }] } });
  expect(http.edited).toEqual([id]);
  expect(await request('PATCH', `/webhooks/${webhook.id}/${webhook.token}/messages/${MESSAGE}`, { content: 'v3' })).toMatchObject({ status: 404, json: { code: 10008 } });
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

const FORUM = '100000000000000020';
const clients: NativeTestClient[] = [];
afterEach(async () => { vi.useRealTimers(); for (const c of clients.splice(0)) await c.client.destroy(); });
async function forumSetup(options: { community?: boolean } = {}) {
  const http = new FakeDiscordHttp();
  http.addGuild(GUILD, options);
  http.addChannel(FORUM, { guildId: GUILD, type: ChannelType.GuildForum });
  const c = await createNativeTestClient(http); clients.push(c);
  const forum = await c.client.channels.fetch(FORUM) as ForumChannel;
  return { ...c, http, forum };
}
const apiError = async (promise: Promise<unknown>) => {
  const error = await promise.catch(e => e);
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
};

it('answers unknown channels with 10003 and deletes channels', async () => {
  const { client, http } = await forumSetup();
  const error = await apiError(client.channels.fetch('100000000000000404', { force: true }));
  expect(error).toMatchObject({ status: 404, code: 10003, message: 'Unknown Channel' });
  const forum = await client.channels.fetch(FORUM) as ForumChannel;
  const post = await forum.threads.create({ name: 'Post', message: { content: 'Body' } });
  await forum.delete();
  expect(http.channels.has(FORUM)).toBe(false);
  expect(http.channels.has(post.id)).toBe(false);
  expect(http.messages.has(post.id)).toBe(false);
  expect(http.deletedChannels).toEqual(expect.arrayContaining([FORUM, post.id]));
  await apiError(client.channels.fetch(FORUM, { force: true }));
});

it('creates forums only in community guilds and lists guild channels', async () => {
  const { client } = await forumSetup();
  const guild = client.guilds.cache.get(GUILD)!;
  const created = await guild.channels.create({ name: 'templates', type: ChannelType.GuildForum });
  expect(created.type).toBe(ChannelType.GuildForum);
  const channels = await guild.channels.fetch();
  expect(channels.has(created.id)).toBe(true);
  expect(guild.features).toContain('COMMUNITY');

  const plain = await forumSetup({ community: false });
  expect(plain.client.guilds.cache.get(GUILD)!.features).not.toContain('COMMUNITY');
  const error = await apiError(plain.client.guilds.cache.get(GUILD)!.channels.create({ name: 'templates', type: ChannelType.GuildForum }));
  expect(error).toMatchObject({ status: 400, code: 50024, message: 'Cannot execute action on this channel type' });
  await plain.client.guilds.cache.get(GUILD)!.channels.create({ name: 'text', type: ChannelType.GuildText });
});

it('creates forum posts with a starter message that shares the thread id', async () => {
  const { forum, http } = await forumSetup();
  const post = await forum.threads.create({
    name: 'Welcome', message: { content: 'Hello', embeds: [{ title: 'Embed' }] },
  });
  expect(post.parentId).toBe(FORUM);
  expect(post.ownerId).toBe(http.botId);
  expect(post.archived).toBe(false);
  expect(post.locked).toBe(false);
  expect(http.channels.get(post.id)).toMatchObject({ type: ChannelType.PublicThread, name: 'Welcome', parent_id: FORUM, owner_id: http.botId });
  const starter = await post.fetchStarterMessage();
  expect(starter?.id).toBe(post.id);
  expect(starter?.content).toBe('Hello');
  expect(starter?.embeds[0]?.title).toBe('Embed');
});

it('uploads files with a forum post, signs urls and re-signs them on every fetch', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
  const { forum, http } = await forumSetup();
  const post = await forum.threads.create({
    name: 'Files',
    message: { content: 'With file', files: [{ attachment: Buffer.from('png bytes'), name: 'pic.png' }] },
  });
  const first = (await post.fetchStarterMessage())!.attachments.first()!;
  expect(first.name).toBe('pic.png');
  expect(first.size).toBe(9);
  const url = new URL(first.url);
  expect(url.origin + url.pathname).toBe(`https://cdn.discordapp.com/attachments/${post.id}/${first.id}/pic.png`);
  const expires = Math.floor(Date.now() / 1000) + 24 * 3600;
  expect(url.searchParams.get('ex')).toBe(expires.toString(16));
  expect(url.searchParams.get('is')).toBe(Math.floor(Date.now() / 1000).toString(16));
  expect(url.searchParams.get('hm')).toMatch(/^[0-9a-f]{64}$/);
  expect(http.files.get(first.id)).toMatchObject({ filename: 'pic.png', channelId: post.id });
  expect(Buffer.from(http.files.get(first.id)!.data).toString()).toBe('png bytes');

  vi.setSystemTime(new Date('2026-03-01T13:00:00Z'));
  const again = (await post.messages.fetch({ message: post.id, force: true })).attachments.first()!;
  const next = new URL(again.url);
  expect(next.searchParams.get('ex')).toBe((Math.floor(Date.now() / 1000) + 24 * 3600).toString(16));
  expect(next.searchParams.get('ex')).not.toBe(url.searchParams.get('ex'));
  expect(next.searchParams.get('hm')).not.toBe(url.searchParams.get('hm'));
});

it('moves attachments an embed shows into the embed, as Discord does', async () => {
  const { forum, http } = await forumSetup();
  const post = await forum.threads.create({
    name: 'Embedded',
    message: {
      embeds: [{ title: 'T', image: { url: 'attachment://pic.png' }, footer: { text: 'F', icon_url: 'attachment://icon.png' } }],
      files: [{ attachment: Buffer.from('pic'), name: 'pic.png' }, { attachment: Buffer.from('icon'), name: 'icon.png' }, { attachment: Buffer.from('x'), name: 'loose.txt' }],
    },
  });
  const starter = (await post.fetchStarterMessage())!;
  expect(starter.attachments.map((a) => a.name)).toEqual(['loose.txt']);
  const pic = [...http.files.entries()].find(([, file]) => file.filename === 'pic.png')![0];
  expect(starter.embeds[0]!.image!.url).toMatch(new RegExp(`^https://cdn\\.discordapp\\.com/attachments/${post.id}/${pic}/pic\\.png\\?ex=`));
  expect(starter.embeds[0]!.footer!.iconURL).toMatch(/\/icon\.png\?ex=/);

  // An edit keeps an embedded attachment by id and can still reference it by name.
  const edited = await starter.edit({ embeds: [{ title: 'T2', image: { url: 'attachment://pic.png' } }], attachments: [{ id: pic } as never] });
  expect(edited.embeds[0]!.image!.url).toContain(`/${pic}/pic.png?ex=`);
  expect(edited.attachments.size).toBe(0);
  expect(http.files.has(pic)).toBe(true);
});

it('edits and archives posts through channel PATCH', async () => {
  const { forum, http } = await forumSetup();
  http.channels.set(FORUM, { ...http.channels.get(FORUM)!, available_tags: [{ id: '100000000000000777', name: 'Tag', moderated: false, emoji_id: null, emoji_name: null }] } as never);
  const post = await forum.threads.create({ name: 'Old', message: { content: 'Body' } }) as ThreadChannel;
  await post.setName('New');
  await post.setLocked(true);
  await post.setAppliedTags(['100000000000000777']);
  expect(http.channels.get(post.id)).toMatchObject({ name: 'New', applied_tags: ['100000000000000777'], thread_metadata: { archived: false, locked: true } });
  await post.setArchived(true);
  expect(http.channels.get(post.id)).toMatchObject({ thread_metadata: { archived: true, locked: true } });
  await post.setArchived(false);
  expect(http.channels.get(post.id)).toMatchObject({ thread_metadata: { archived: false } });
});

it('rejects message edits in archived threads with 50083 and supports kept and new attachments', async () => {
  const { forum, http } = await forumSetup();
  const post = await forum.threads.create({
    name: 'Edit',
    message: { content: 'v1', files: [{ attachment: Buffer.from('one'), name: 'one.txt' }, { attachment: Buffer.from('two'), name: 'two.txt' }] },
  });
  const starter = (await post.fetchStarterMessage())!;
  const [one, two] = [...starter.attachments.values()];
  const edited = await starter.edit({
    content: 'v2',
    attachments: [one!],
    files: [{ attachment: Buffer.from('three'), name: 'three.txt' }],
  });
  expect(edited.content).toBe('v2');
  expect(edited.attachments.map(a => a.name)).toEqual(['one.txt', 'three.txt']);
  expect(edited.attachments.first()!.id).toBe(one!.id);
  expect(http.files.has(two!.id)).toBe(false);
  const three = edited.attachments.last()!;
  expect(Buffer.from(http.files.get(three.id)!.data).toString()).toBe('three');

  await post.setArchived(true);
  const error = await apiError(edited.edit({ content: 'v3' }));
  expect(error).toMatchObject({ status: 400, code: 50083, message: 'Thread is archived' });
  expect(http.messages.get(post.id)!.content).toBe('v2');
});

it('serves guild members with their roles, and computes permissions from roles and overwrites', async () => {
  const http = new FakeDiscordHttp();
  const MEMBER = '100000000000000201';
  const ROLE = '100000000000000301';
  http.addGuild(GUILD);
  http.addRole(GUILD, { id: ROLE, permissions: 0n });
  http.addMember(GUILD, MEMBER, { roles: [ROLE] });
  http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
  http.addChannel(OTHER, {
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionOverwrites: [{ id: GUILD, type: 0, deny: String(PermissionFlagsBits.ViewChannel), allow: '0' }],
  });
  const { client } = await createNativeTestClient(http);
  try {
    const guild = await client.guilds.fetch({ guild: GUILD, force: true });
    const member = await guild.members.fetch(MEMBER);
    expect([...member.roles.cache.keys()].sort()).toEqual([GUILD, ROLE].sort());
    const visible = await client.channels.fetch(CHANNEL);
    const hidden = await client.channels.fetch(OTHER);
    expect(visible && 'permissionsFor' in visible && visible.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(hidden && 'permissionsFor' in hidden && hidden.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)).toBe(false);
    await expect(guild.members.fetch('100000000000000202')).rejects.toMatchObject({ status: 404, code: 10007 });
  } finally {
    await client.destroy();
  }
});

describe('webhook components', () => {
  const button = { type: 1, components: [{ type: 2, style: 1, custom_id: 'go', label: 'Go' }] };
  const link = { type: 1, components: [{ type: 2, style: 5, url: 'https://example.com', label: 'Link' }] };
  const select = { type: 1, components: [{ type: 3, custom_id: 'pick', options: [] }] };
  const setup = (options?: { applicationId?: string }) => {
    const http = new FakeDiscordHttp();
    http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
    const webhook = http.addWebhook(CHANNEL, undefined, options);
    const request = (method: string, path: string, body?: unknown, query = '') =>
      http.answer({ method, path, query, body, authorized: false });
    return { http, webhook, request, path: `/webhooks/${webhook.id}/${webhook.token}` };
  };

  it('stores interactive components of an own webhook sent with with_components', async () => {
    const { request, path, http } = setup();
    const sent = await request('POST', path, { content: 'x', components: [button] }, '?with_components=true');
    expect(sent).toMatchObject({ status: 200, json: { components: [button] } });
    expect(http.messages.get((sent.json as { id: string }).id)?.components).toEqual([button]);
  });

  it('rejects interactive components without with_components', async () => {
    const { request, path } = setup();
    expect(await request('POST', path, { components: [button] })).toMatchObject({ status: 400, json: { code: 50035 } });
    expect(await request('POST', path, { components: [select] }, '?with_components=false')).toMatchObject({ status: 400, json: { code: 50035 } });
  });

  it('rejects interactive components of a webhook owned by another application', async () => {
    const { request, path } = setup({ applicationId: '100000000000000999' });
    expect(await request('POST', path, { components: [button] }, '?with_components=true')).toMatchObject({ status: 400, json: { code: 50035 } });
  });

  it('allows link buttons without with_components', async () => {
    const { request, path } = setup({ applicationId: '100000000000000999' });
    expect(await request('POST', path, { components: [link] })).toMatchObject({ status: 200, json: { components: [link] } });
  });

  it('replaces components on edit and applies the same rules', async () => {
    const { request, path } = setup();
    const id = ((await request('POST', path, { content: 'x', components: [button] }, '?with_components=true')).json as { id: string }).id;
    expect(await request('PATCH', `${path}/messages/${id}`, { components: [select] })).toMatchObject({ status: 400, json: { code: 50035 } });
    expect(await request('PATCH', `${path}/messages/${id}`, { components: [select] }, '?with_components=true'))
      .toMatchObject({ status: 200, json: { components: [select] } });
    expect(await request('PATCH', `${path}/messages/${id}`, { content: 'y' })).toMatchObject({ json: { content: 'y', components: [select] } });
    expect(await request('PATCH', `${path}/messages/${id}`, { components: [] })).toMatchObject({ json: { components: [] } });
  });
});

describe('message listing and bulk delete', () => {
  const snowflake = (ageMs: number): string => String((BigInt(Date.now() - ageMs) - 1420070400000n) << 22n);
  const setup = () => {
    const http = new FakeDiscordHttp();
    http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
    const request = (method: string, path: string, body?: unknown, query = '') => http.answer({ method, path, query, body, authorized: true });
    return { http, request };
  };
  const ids = (answer: { json?: unknown }) => (answer.json as { id: string }[]).map(message => message.id);

  it('lists messages after an id oldest-last, limited', async () => {
    const { http, request } = setup();
    const all = [4000, 3000, 2000, 1000, 500].map(snowflake);
    for (const id of all) http.addMessage(CHANNEL, id);
    http.addMessage(OTHER, snowflake(10));
    const [a, b, c, d, e] = all as [string, string, string, string, string];
    expect(ids(await request('GET', `/channels/${CHANNEL}/messages`, undefined, `?after=${a}&limit=3`))).toEqual([d, c, b]);
    expect(ids(await request('GET', `/channels/${CHANNEL}/messages`, undefined, `?after=${a}`))).toEqual([e, d, c, b]);
    expect(ids(await request('GET', `/channels/${CHANNEL}/messages`, undefined, `?before=${e}&limit=2`))).toEqual([d, c]);
    expect(ids(await request('GET', `/channels/${CHANNEL}/messages`, undefined, '?limit=1'))).toEqual([e]);
    expect(await request('GET', `/channels/${CHANNEL}/messages`, undefined, '?limit=101')).toMatchObject({ status: 400, json: { code: 50035 } });
    expect(await request('GET', '/channels/100000000000000404/messages')).toMatchObject({ status: 404, json: { code: 10003 } });
  });

  it('serves reactions, replies, polls, stickers, threads and forwards in a form discord.js parses', async () => {
    const { http } = setup();
    const original = snowflake(3000);
    const reply = snowflake(2000);
    const forward = snowflake(1000);
    http.addMessage(CHANNEL, original, { content: 'first', threadId: original });
    http.addMessage(CHANNEL, reply, {
      referenceId: original, poll: true, flags: 4, components: [{ type: 1, components: [] }],
      reactions: [{ emoji: { id: null, name: '\u{1F44D}' }, count: 2 }],
      stickers: [{ id: '100000000000000300', name: 'wave', format: 1, guildId: GUILD }],
    });
    http.addMessage(CHANNEL, forward, { snapshots: [{ content: 'inner', files: [{ filename: 'a.txt', data: 'abc' }] }] });
    const { client } = await createNativeTestClient(http);
    try {
      const channel = await client.channels.fetch(CHANNEL);
      if (!channel?.isTextBased()) throw new Error('text channel expected');
      const fetched = [...(await channel.messages.fetch({ after: snowflake(5000), limit: 10 })).values()];
      expect(fetched.map(message => message.id)).toEqual([forward, reply, original].sort().reverse());
      const [f, r, o] = [forward, reply, original].map(id => fetched.find(message => message.id === id)!);
      expect(o!.thread?.id).toBe(original);
      expect(r!.reference?.messageId).toBe(original);
      expect(r!.type).toBe(19);
      expect((await r!.fetchReference()).content).toBe('first');
      expect(r!.poll).not.toBeNull();
      expect(r!.flags.bitfield).toBe(4);
      expect(r!.components).toHaveLength(1);
      expect(r!.reactions.cache.first()).toMatchObject({ count: 2 });
      expect(r!.stickers.first()).toMatchObject({ name: 'wave', guildId: GUILD });
      expect(f!.reference?.type).toBe(1);
      expect(f!.messageSnapshots.first()?.content).toBe('inner');
      expect(f!.messageSnapshots.first()?.attachments.first()?.name).toBe('a.txt');
    } finally {
      await client.destroy();
    }
  });

  it('bulk deletes young messages', async () => {
    const { http, request } = setup();
    const [a, b, c] = [3000, 2000, 1000].map(snowflake) as [string, string, string];
    for (const id of [a, b, c]) http.addMessage(CHANNEL, id);
    expect(await request('POST', `/channels/${CHANNEL}/messages/bulk-delete`, { messages: [a, b] })).toMatchObject({ status: 204 });
    expect([...http.messages.keys()]).toEqual([c]);
    expect(http.botDeleted).toEqual([a, b]);
  });

  it('rejects a bulk delete with an old message (50034)', async () => {
    const { http, request } = setup();
    const young = snowflake(1000);
    const old = snowflake(15 * 24 * 3600_000);
    http.addMessage(CHANNEL, young); http.addMessage(CHANNEL, old);
    expect(await request('POST', `/channels/${CHANNEL}/messages/bulk-delete`, { messages: [young, old] })).toMatchObject({ status: 400, json: { code: 50034 } });
    expect(http.messages.size).toBe(2);
    expect(http.botDeleted).toEqual([]);
    expect(await request('POST', `/channels/${CHANNEL}/messages/bulk-delete`, { messages: [young] })).toMatchObject({ status: 400, json: { code: 50035 } });
  });

  it('ignores unknown and foreign ids and deletes duplicates once', async () => {
    const { http, request } = setup();
    const [a, b] = [3000, 2000].map(snowflake) as [string, string];
    const foreign = snowflake(1000);
    http.addMessage(CHANNEL, a); http.addMessage(CHANNEL, b); http.addMessage(OTHER, foreign);
    expect(await request('POST', `/channels/${CHANNEL}/messages/bulk-delete`, { messages: [a, a, snowflake(5), foreign] })).toMatchObject({ status: 204 });
    expect(http.botDeleted).toEqual([a]);
    expect([...http.messages.keys()].sort()).toEqual([b, foreign].sort());
  });

  it('lists messages around an id', async () => {
    const { http, request } = setup();
    const all = [5000, 4000, 3000, 2000, 1000].map(snowflake) as [string, string, string, string, string];
    for (const id of all) http.addMessage(CHANNEL, id);
    const [a, b, c, d, e] = all;
    const around = async (limit: number) => ids(await request('GET', `/channels/${CHANNEL}/messages`, undefined, `?around=${c}&limit=${limit}`));
    expect(await around(1)).toEqual([c]);
    expect(await around(3)).toEqual([d, c, b]);
    expect(await around(5)).toEqual([e, d, c, b, a]);
  });
});

describe('webhook listing and sends', () => {
  const setup = () => {
    const http = new FakeDiscordHttp();
    http.addGuild(GUILD); http.addChannel(CHANNEL, { guildId: GUILD, type: ChannelType.GuildText });
    return http;
  };

  it("lists a channel's webhooks", async () => {
    const http = setup();
    const own = http.addWebhook(CHANNEL, { name: 'Move' });
    http.addWebhook(CHANNEL, undefined, { name: 'Foreign', applicationId: null });
    http.addWebhook(OTHER, { name: 'Sticky', applicationId: '100000000000000999' });
    http.addWebhook(OTHER);
    expect(http.addWebhook(CHANNEL, own)).toMatchObject({ id: own.id, name: 'Move' });
    const answer = await http.answer({ method: 'GET', path: `/channels/${CHANNEL}/webhooks`, query: '', body: undefined, authorized: true });
    expect((answer.json as { name: string; application_id: string | null }[]).map(w => [w.name, w.application_id]))
      .toEqual([['Move', http.applicationId], ['Foreign', null]]);
    expect(await http.answer({ method: 'GET', path: '/channels/100000000000000404/webhooks', query: '', body: undefined, authorized: true }))
      .toMatchObject({ status: 404, json: { code: 10003 } });
  });

  it('records files, flags and allowed mentions of webhook sends', async () => {
    const http = setup();
    const webhook = http.addWebhook(CHANNEL);
    const form = new FormData();
    form.set('payload_json', JSON.stringify({
      content: 'x', flags: 4096, allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: 'a.png', description: 'alt' }],
    }));
    form.set('files[0]', new File(['abcd'], 'a.png', { type: 'image/png' }));
    await http.answer({ method: 'POST', path: `/webhooks/${webhook.id}/${webhook.token}`, query: '', body: form, authorized: false });
    await http.answer({ method: 'POST', path: `/webhooks/${webhook.id}/${webhook.token}`, query: '', body: { content: 'y' }, authorized: false });
    expect(http.sent[0]).toMatchObject({
      options: { silent: true, flags: 4096, allowedMentions: { parse: [] } },
      files: [{ name: 'a.png', description: 'alt', size: 4 }],
    });
    expect(http.sent[1]).toMatchObject({ options: { silent: false, flags: 0, allowedMentions: undefined }, files: [] });
  });
});
