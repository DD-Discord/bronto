import { fakeRest } from '@bronto/core/testing';
import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  createRestStickyDiscord,
  MissingWebhookPermissionError,
  TemplateUnavailableError,
  UnknownMessageError,
  UnknownWebhookError,
} from '../src/discord.js';

function fakeDiscord(answer: Parameters<typeof fakeRest>[0]) {
  const { rest, requests } = fakeRest(answer);
  return { discord: createRestStickyDiscord({ rest } as unknown as Client), requests };
}

const error = (code: number, status = 404) => ({ status, json: { code, message: `error ${code}` } });
const target = { id: '100000000000000040', token: 'fake-token', threadId: null };

describe('createRestStickyDiscord', () => {
  it('posts through the webhook without bot auth, into threads, silently and with the configured name', async () => {
    const { discord, requests } = fakeDiscord(() => ({ status: 200, json: { id: '100000000000000050' } }));
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
        body: {
          username: 'Sticky',
          avatar_url: 'https://example.com/a.png',
          content: 'Hello',
          embeds: [{ title: 'T' }],
          flags: 4096,
          allowed_mentions: { parse: [] },
        },
        authorized: false,
      },
    ]);
  });

  it('leaves out empty content and notification flags when not silent', async () => {
    const { discord, requests } = fakeDiscord(() => ({ status: 200, json: { id: '1' } }));
    await discord.send(target, { content: '', embeds: [{ title: 'T' }] }, { silent: false, username: 'Sticky' });
    expect(requests[0]!.body).toEqual({ username: 'Sticky', embeds: [{ title: 'T' }], flags: 0, allowed_mentions: { parse: [] } });
    expect(requests[0]!.query).toBe('?wait=true');
  });

  it('maps unknown webhooks and messages', async () => {
    const gone = fakeDiscord(() => error(10015));
    await expect(gone.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' })).rejects.toBeInstanceOf(
      UnknownWebhookError,
    );
    await expect(gone.discord.deleteMessage(target, '1')).rejects.toBeInstanceOf(UnknownWebhookError);
    // A revoked token is as unusable as a deleted webhook.
    const revoked = fakeDiscord(() => error(50027, 401));
    await expect(revoked.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' })).rejects.toBeInstanceOf(
      UnknownWebhookError,
    );
    await expect(revoked.discord.deleteMessage(target, '1')).rejects.toBeInstanceOf(UnknownWebhookError);
    const missing = fakeDiscord(() => error(10008));
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
    const { discord } = fakeDiscord((_method, path) =>
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
    const noChannel = fakeDiscord(() => error(50001, 403));
    await expect(noChannel.discord.fetchTemplate('1', '2', '3')).rejects.toThrow('I cannot see its channel.');
    const noMessage = fakeDiscord((_m, path) =>
      path.includes('/messages/') ? error(10008) : { status: 200, json: { id: '2', type: 0, guild_id: '1' } },
    );
    await expect(noMessage.discord.fetchTemplate('1', '2', '3')).rejects.toThrow('it does not exist.');
  });

  it('delegates webhook creation to core and reuses a valid known webhook', async () => {
    const known = { id: '100000000000000042', token: 'mine' };
    const reused = fakeDiscord((_method, path) =>
      path.startsWith('/channels/')
        ? { status: 200, json: { id: '100000000000000010', type: 0 } }
        : { status: 200, json: { id: known.id, channel_id: '100000000000000010' } },
    );
    expect(await reused.discord.ensureWebhook('100000000000000010', known, 'Sticky')).toEqual({ ...known, threadId: null });
    const created = fakeDiscord((method, path) =>
      method === 'POST' ? { status: 200, json: { id: '100000000000000043', token: 'new' } } : path.startsWith('/channels/') ? { status: 200, json: { id: '100000000000000010', type: 0 } } : error(10015),
    );
    expect(await created.discord.ensureWebhook('100000000000000010', known, 'Sticky')).toEqual({ id: '100000000000000043', token: 'new', threadId: null });
    expect(created.requests.at(-1)).toMatchObject({ method: 'POST', path: '/channels/100000000000000010/webhooks', body: { name: 'Sticky' }, authorized: true });
  });

  it('reports missing Manage Webhooks', async () => {
    const { discord } = fakeDiscord(() => error(50013, 403));
    await expect(discord.createWebhook('100000000000000010', 'Sticky')).rejects.toBeInstanceOf(MissingWebhookPermissionError);
  });

  it('finds tokens Discord reveals', async () => {
    const { discord } = fakeDiscord(() => ({
      status: 200,
      json: [{ id: '100000000000000044', token: 'shown' }, { id: '100000000000000045' }],
    }));
    expect(await discord.findWebhookToken('100000000000000010', '100000000000000044')).toBe('shown');
    expect(await discord.findWebhookToken('100000000000000010', '100000000000000045')).toBeNull();
  });

  it('describes channels and tells gone ones from hidden ones', async () => {
    const thread = fakeDiscord(() => ({ status: 200, json: { id: '11', type: 11, guild_id: '1', parent_id: '10' } }));
    expect(await thread.discord.channelInfo('11')).toEqual({ guildId: '1', isThread: true, parentId: '10' });
    const gone = fakeDiscord(() => error(10003));
    expect(await gone.discord.channelInfo('11')).toBe('gone');
    const hidden = fakeDiscord(() => error(50001, 403));
    expect(await hidden.discord.channelInfo('11')).toBe('forbidden');
    const denied = fakeDiscord(() => error(50013, 403));
    expect(await denied.discord.channelInfo('11')).toBe('forbidden');
  });

  it('deletes webhooks and messages, treating unknown ones as deleted', async () => {
    const { discord, requests } = fakeDiscord(() => error(10015));
    await discord.deleteWebhook(target);
    await discord.deleteWebhookById('100000000000000040');
    expect(requests.map((request) => [request.method, request.path, request.authorized])).toEqual([
      ['DELETE', '/webhooks/100000000000000040/fake-token', false],
      ['DELETE', '/webhooks/100000000000000040', true],
    ]);
    const messages = fakeDiscord(() => error(10008));
    await messages.discord.deleteChannelMessage('100000000000000010', '100000000000000050');
    expect(messages.requests[0]).toMatchObject({ method: 'DELETE', path: '/channels/100000000000000010/messages/100000000000000050', authorized: true });
  });

  it('keeps the webhook token out of errors it rethrows', async () => {
    const leaks = (e: unknown) => {
      const err = e as { url?: unknown; message: string };
      return JSON.stringify(err) + String(err.url) + err.message;
    };
    const failed = fakeDiscord(() => ({ status: 500, json: { message: 'boom' } }));
    const sendError = await failed.discord.send(target, { content: 'x', embeds: [] }, { silent: true, username: 'S' }).catch((e: unknown) => e);
    expect(sendError).toBeInstanceOf(Error);
    expect(leaks(sendError)).not.toContain('fake-token');
    const denied = fakeDiscord(() => error(50013, 403));
    const deleteError = await denied.discord.deleteMessage(target, '1').catch((e: unknown) => e);
    expect(deleteError).toMatchObject({ code: 50013 });
    expect(leaks(deleteError)).not.toContain('fake-token');
    const refused = fakeDiscord(() => error(50027, 401));
    const hookError = await refused.discord.deleteWebhook(target).catch((e: unknown) => e);
    expect(leaks(hookError)).not.toContain('fake-token');
  });
});
