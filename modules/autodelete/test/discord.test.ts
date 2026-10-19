import { fakeRest } from '@bronto/core/testing';
import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createRestAutodeleteDiscord } from '../src/discord.js';

function fakeDiscord(answer: Parameters<typeof fakeRest>[0]) {
  const { rest, requests } = fakeRest(answer);
  return { discord: createRestAutodeleteDiscord({ rest } as unknown as Client), requests };
}

const error = (code: number, status = 404) => ({ status, json: { code, message: `error ${code}` } });

describe('createRestAutodeleteDiscord', () => {
  it('fetches the text and attachment count of a post', async () => {
    const { discord } = fakeDiscord(() => ({ status: 200, json: { content: 'Hi', attachments: [{}, {}] } }));
    expect(await discord.fetchPost('1', '2')).toEqual({ content: 'Hi', attachmentCount: 2 });
  });

  it('returns null for a post or channel that is gone', async () => {
    expect(await fakeDiscord(() => error(10008)).discord.fetchPost('1', '2')).toBeNull();
    expect(await fakeDiscord(() => error(10003)).discord.fetchPost('1', '2')).toBeNull();
  });

  it('maps delete outcomes', async () => {
    expect(await fakeDiscord(() => ({ status: 204, json: null })).discord.deletePost('1', '2')).toBe('deleted');
    expect(await fakeDiscord(() => error(10008)).discord.deletePost('1', '2')).toBe('gone');
    expect(await fakeDiscord(() => error(50013, 403)).discord.deletePost('1', '2')).toBe('forbidden');
    expect(await fakeDiscord(() => error(50001, 403)).discord.deletePost('1', '2')).toBe('forbidden');
    await expect(fakeDiscord(() => error(50035, 400)).discord.deletePost('1', '2')).rejects.toThrow();
  });

  it('sends a DM through a new DM channel and reports closed DMs', async () => {
    const sent = fakeDiscord((method, path) => (path === '/users/@me/channels' ? { status: 200, json: { id: '77' } } : { status: 200, json: { id: '5' } }));
    expect(await sent.discord.sendDm('9', { content: 'Hello' })).toBe('sent');
    expect(sent.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /users/@me/channels', 'POST /channels/77/messages']);
    expect(sent.requests[0]!.body).toEqual({ recipient_id: '9' });
    const attached = fakeDiscord((_method, path) => (path === '/users/@me/channels' ? { status: 200, json: { id: '77' } } : { status: 200, json: { id: '5' } }));
    await attached.discord.sendDm('9', { content: 'Hello', files: [{ name: 'post.txt', data: Buffer.from('text') }] });
    const form = attached.requests[1]!.body as FormData;
    expect((form.get('files[0]') as File).name).toBe('post.txt');
    expect(JSON.parse(form.get('payload_json') as string)).toMatchObject({ content: 'Hello' });
    const closed = fakeDiscord((_method, path) => (path === '/users/@me/channels' ? { status: 200, json: { id: '77' } } : error(50007, 403)));
    expect(await closed.discord.sendDm('9', { content: 'Hello' })).toBe('closed');
  });

  it('keeps the message out of a failed DM', async () => {
    const failing = fakeDiscord((_method, path) => (path === '/users/@me/channels' ? { status: 200, json: { id: '77' } } : error(50035, 400)));
    const failure = await failing.discord.sendDm('9', { content: 'secret text', files: [{ name: 'post.txt', data: Buffer.from('secret file') }] }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('secret');
    expect(Object.keys(failure as object)).not.toContain('requestBody');
  });
});
