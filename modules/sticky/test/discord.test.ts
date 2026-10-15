import { REST, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  createRestStickyDiscord,
  MissingWebhookPermissionError,
  TemplateUnavailableError,
  UnknownMessageError,
  UnknownWebhookError,
} from '../src/discord.js';

interface Recorded {
  method: string;
  path: string;
  query: string;
  body: unknown;
  authorized: boolean;
}

/** A REST client whose requests go to `answer` instead of Discord. */
function fakeRest(answer: (method: string, path: string) => { status: number; json: unknown }) {
  const requests: Recorded[] = [];
  const rest = new REST({
    retries: 0,
    makeRequest: async (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/api/v10', '');
      requests.push({
        method: init.method ?? 'GET',
        path,
        query: parsed.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        authorized: new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).has('authorization'),
      });
      const { status, json } = answer(init.method ?? 'GET', path);
      const text = status === 204 ? '' : JSON.stringify(json);
      return {
        body: null,
        bodyUsed: false,
        ok: status < 300,
        status,
        statusText: String(status),
        headers: new Headers(status === 204 ? {} : { 'content-type': 'application/json' }),
        text: async () => text,
        json: async () => (text === '' ? null : JSON.parse(text)),
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      } as never;
    },
  }).setToken('bot-token');
  const discord = createRestStickyDiscord({ rest, application: { id: '100000000000000900' } } as unknown as Client);
  return { discord, requests };
}

const error = (code: number, status = 404) => ({ status, json: { code, message: `error ${code}` } });
const target = { id: '100000000000000040', token: 'fake-token', threadId: null };

describe('createRestStickyDiscord', () => {
  it('posts through the webhook without bot auth, into threads, silently and with the configured name', async () => {
    const { discord, requests } = fakeRest(() => ({ status: 200, json: { id: '100000000000000050' } }));
    const id = await discord.send(
      { ...target, threadId: '100000000000000011' },
      { content: 'Hello', embeds: [{ title: 'T' }] },
      { silent: true, username: 'Sticky', avatarUrl: 'https://example.com/a.png' },
    );
    expect(id).toBe('100000000000000050');
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/webhooks/100000000000000040/fake-token',
        query: '?thread_id=100000000000000011&wait=true',
        body: { username: 'Sticky', avatar_url: 'https://example.com/a.png', content: 'Hello', embeds: [{ title: 'T' }], flags: 4096 },
        authorized: false,
      },
    ]);
  });

  it('leaves out empty content and notification flags when not silent', async () => {
    const { discord, requests } = fakeRest(() => ({ status: 200, json: { id: '1' } }));
    await discord.send(target, { content: '', embeds: [{ title: 'T' }] }, { silent: false, username: 'Sticky' });
    expect(requests[0]!.body).toEqual({ username: 'Sticky', embeds: [{ title: 'T' }], flags: 0 });
    expect(requests[0]!.query).toBe('?wait=true');
  });

  it('maps unknown webhooks and messages', async () => {
    const gone = fakeRest(() => error(10015));
    await expect(gone.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' })).rejects.toBeInstanceOf(
      UnknownWebhookError,
    );
    await expect(gone.discord.deleteMessage(target, '1')).rejects.toBeInstanceOf(UnknownWebhookError);
    // A revoked token is as unusable as a deleted webhook.
    const revoked = fakeRest(() => error(50027, 401));
    await expect(revoked.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' })).rejects.toBeInstanceOf(
      UnknownWebhookError,
    );
    await expect(revoked.discord.deleteMessage(target, '1')).rejects.toBeInstanceOf(UnknownWebhookError);
    const missing = fakeRest(() => error(10008));
    await expect(missing.discord.deleteMessage({ ...target, threadId: '100000000000000011' }, '100000000000000050')).rejects.toBeInstanceOf(
      UnknownMessageError,
    );
    expect(missing.requests[0]).toMatchObject({
      method: 'DELETE',
      path: '/webhooks/100000000000000040/fake-token/messages/100000000000000050',
      query: '?thread_id=100000000000000011',
      authorized: false,
    });
  });

  it('reads a template only from the given guild', async () => {
    const { discord } = fakeRest((_method, path) =>
      path.endsWith('/messages/100000000000000021')
        ? { status: 200, json: { id: '100000000000000021', content: 'Rules', embeds: [{ type: 'rich', id: '9', title: 'R' }] } }
        : { status: 200, json: { id: '100000000000000020', type: 0, guild_id: '100000000000000001' } },
    );
    expect(await discord.fetchTemplate('100000000000000001', '100000000000000020', '100000000000000021')).toEqual({
      content: 'Rules',
      embeds: [{ title: 'R' }],
    });
    await expect(discord.fetchTemplate('100000000000000002', '100000000000000020', '100000000000000021')).rejects.toThrow(
      new TemplateUnavailableError('it is not in this server.'),
    );
  });

  it('explains unreadable templates', async () => {
    const noChannel = fakeRest(() => error(50001, 403));
    await expect(noChannel.discord.fetchTemplate('1', '2', '3')).rejects.toThrow('I cannot see its channel.');
    const noMessage = fakeRest((_m, path) =>
      path.includes('/messages/') ? error(10008) : { status: 200, json: { id: '2', type: 0, guild_id: '1' } },
    );
    await expect(noMessage.discord.fetchTemplate('1', '2', '3')).rejects.toThrow('it does not exist.');
  });

  it('reuses a webhook this application owns and creates one otherwise', async () => {
    let created = false;
    const owned = fakeRest((method) =>
      method === 'GET'
        ? {
            status: 200,
            json: [
              { id: '100000000000000041', application_id: '100000000000000999', token: 'other' },
              { id: '100000000000000042', application_id: '100000000000000900', token: 'mine' },
            ],
          }
        : { status: 200, json: {} },
    );
    expect(await owned.discord.ensureWebhook('100000000000000010', 'Sticky')).toEqual({ id: '100000000000000042', token: 'mine' });
    const none = fakeRest((method) => {
      if (method === 'GET') return { status: 200, json: [] };
      created = true;
      return { status: 200, json: { id: '100000000000000043', token: 'new' } };
    });
    expect(await none.discord.ensureWebhook('100000000000000010', 'Sticky')).toEqual({ id: '100000000000000043', token: 'new' });
    expect(created).toBe(true);
    expect(none.requests[1]).toMatchObject({ method: 'POST', path: '/channels/100000000000000010/webhooks', body: { name: 'Sticky' }, authorized: true });
  });

  it('reports missing Manage Webhooks', async () => {
    const { discord } = fakeRest(() => error(50013, 403));
    await expect(discord.ensureWebhook('100000000000000010', 'Sticky')).rejects.toBeInstanceOf(MissingWebhookPermissionError);
    await expect(discord.createWebhook('100000000000000010', 'Sticky')).rejects.toBeInstanceOf(MissingWebhookPermissionError);
  });

  it('finds tokens Discord reveals', async () => {
    const { discord } = fakeRest(() => ({
      status: 200,
      json: [{ id: '100000000000000044', token: 'shown' }, { id: '100000000000000045' }],
    }));
    expect(await discord.findWebhookToken('100000000000000010', '100000000000000044')).toBe('shown');
    expect(await discord.findWebhookToken('100000000000000010', '100000000000000045')).toBeNull();
  });

  it('describes channels and tells gone ones from hidden ones', async () => {
    const thread = fakeRest(() => ({ status: 200, json: { id: '11', type: 11, guild_id: '1', parent_id: '10' } }));
    expect(await thread.discord.channelInfo('11')).toEqual({ guildId: '1', isThread: true, parentId: '10' });
    const gone = fakeRest(() => error(10003));
    expect(await gone.discord.channelInfo('11')).toBe('gone');
    const hidden = fakeRest(() => error(50001, 403));
    expect(await hidden.discord.channelInfo('11')).toBe('forbidden');
    const denied = fakeRest(() => error(50013, 403));
    expect(await denied.discord.channelInfo('11')).toBe('forbidden');
  });

  it('deletes webhooks and messages, treating unknown ones as deleted', async () => {
    const { discord, requests } = fakeRest(() => error(10015));
    await discord.deleteWebhook(target);
    await discord.deleteWebhookById('100000000000000040');
    expect(requests.map((request) => [request.method, request.path, request.authorized])).toEqual([
      ['DELETE', '/webhooks/100000000000000040/fake-token', false],
      ['DELETE', '/webhooks/100000000000000040', true],
    ]);
    const messages = fakeRest(() => error(10008));
    await messages.discord.deleteChannelMessage('100000000000000010', '100000000000000050');
    expect(messages.requests[0]).toMatchObject({ method: 'DELETE', path: '/channels/100000000000000010/messages/100000000000000050', authorized: true });
  });

  it('keeps the webhook token out of errors it rethrows', async () => {
    const leaks = (e: unknown) => {
      const err = e as { url?: unknown; message: string };
      return JSON.stringify(err) + String(err.url) + err.message;
    };
    const failed = fakeRest(() => ({ status: 500, json: { message: 'boom' } }));
    const sendError = await failed.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' }).catch((e: unknown) => e);
    expect(sendError).toBeInstanceOf(Error);
    expect(leaks(sendError)).not.toContain('fake-token');
    const denied = fakeRest(() => error(50013, 403));
    const deleteError = await denied.discord.deleteMessage(target, '1').catch((e: unknown) => e);
    expect(deleteError).toMatchObject({ code: 50013 });
    expect(leaks(deleteError)).not.toContain('fake-token');
    const refused = fakeRest(() => error(50027, 401));
    const hookError = await refused.discord.deleteWebhook(target).catch((e: unknown) => e);
    expect(leaks(hookError)).not.toContain('fake-token');
  });
});
