import { AllowedMentionsTypes, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fakeRest } from '../testing/rest.js';
import { createWebhooks, MissingWebhookPermissionError, UnknownMessageError, UnknownWebhookError } from './index.js';

const CHANNEL = '100000000000000010';
const THREAD = '100000000000000011';
const known = { id: '100000000000000040', token: 'known-token' };
const error = (code: number, status = 404) => ({ status, json: { code, message: `error ${code}` } });

function setup(answer: Parameters<typeof fakeRest>[0]) {
  const { rest, requests } = fakeRest(answer);
  return { webhooks: createWebhooks({ rest } as unknown as Client), requests };
}

/** Answers channel and webhook lookups; `webhook` is the answer for GET /webhooks/{id}/{token}. */
function lookups(webhook: { status: number; json: unknown }, channel: unknown = { id: CHANNEL, type: 0 }) {
  return (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/channels/')) return { status: 200, json: channel };
    if (method === 'GET' && path.startsWith('/webhooks/')) return webhook;
    return { status: 200, json: { id: '100000000000000041', token: 'new-token' } };
  };
}

describe('ensureWebhook', () => {
  it('keeps a valid known webhook', async () => {
    const { webhooks, requests } = setup(lookups({ status: 200, json: { id: known.id, channel_id: CHANNEL } }));
    expect(await webhooks.ensureWebhook(CHANNEL, known, 'Bot')).toEqual({ ...known, threadId: null });
    expect(requests.map((r) => [r.method, r.path, r.authorized])).toEqual([
      ['GET', `/channels/${CHANNEL}`, true],
      ['GET', `/webhooks/${known.id}/${known.token}`, false],
    ]);
  });

  it('replaces a deleted known webhook', async () => {
    const { webhooks, requests } = setup(lookups(error(10015)));
    expect(await webhooks.ensureWebhook(CHANNEL, known, 'Bot')).toEqual({ id: '100000000000000041', token: 'new-token', threadId: null });
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: `/channels/${CHANNEL}/webhooks`, body: { name: 'Bot' }, authorized: true });
  });

  it('replaces a known webhook of another channel', async () => {
    const { webhooks, requests } = setup(lookups({ status: 200, json: { id: known.id, channel_id: '100000000000000099' } }));
    const target = await webhooks.ensureWebhook(CHANNEL, known, 'Bot');
    expect(target.id).toBe('100000000000000041');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('creates on the parent for a thread', async () => {
    const { webhooks, requests } = setup(
      lookups({ status: 200, json: { id: known.id, channel_id: CHANNEL } }, { id: THREAD, type: 11, parent_id: CHANNEL }),
    );
    expect(await webhooks.ensureWebhook(THREAD, null, 'Bot')).toEqual({ id: '100000000000000041', token: 'new-token', threadId: THREAD });
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/channels/${CHANNEL}/webhooks` });
    const kept = await webhooks.ensureWebhook(THREAD, known, 'Bot');
    expect(kept).toEqual({ ...known, threadId: THREAD });
  });

  it('creates without a known webhook and checks nothing', async () => {
    const { webhooks, requests } = setup(lookups(error(10015)));
    await webhooks.ensureWebhook(CHANNEL, null, 'Bot');
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  it('maps a missing permission', async () => {
    const { webhooks } = setup((method, path) =>
      method === 'GET' && path.startsWith('/channels/') ? { status: 200, json: { id: CHANNEL, type: 0 } } : error(50013, 403),
    );
    await expect(webhooks.ensureWebhook(CHANNEL, null, 'Bot')).rejects.toBeInstanceOf(MissingWebhookPermissionError);
    await expect(webhooks.createWebhook(CHANNEL, 'Bot')).rejects.toMatchObject({ channelId: CHANNEL });
  });
});

describe('checkWebhook', () => {
  it('returns the channel, or null for deleted webhooks and revoked tokens', async () => {
    const valid = setup(() => ({ status: 200, json: { id: known.id, channel_id: CHANNEL } }));
    expect(await valid.webhooks.checkWebhook(known)).toEqual({ channelId: CHANNEL });
    expect(await setup(() => error(10015)).webhooks.checkWebhook(known)).toBeNull();
    expect(await setup(() => error(50027, 401)).webhooks.checkWebhook(known)).toBeNull();
  });

  it('keeps the token out of other errors', async () => {
    const { webhooks } = setup(() => ({ status: 500, json: { message: 'boom' } }));
    const failure = (await webhooks.checkWebhook(known).catch((e: unknown) => e)) as Error & { url?: string };
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message + String(failure.url)).not.toContain(known.token);
  });
});

describe('send', () => {
  const target = { ...known, threadId: THREAD };

  it('posts components with with_components, thread_id and no pings', async () => {
    const { webhooks, requests } = setup(() => ({ status: 200, json: { id: '100000000000000050' } }));
    const id = await webhooks.send(
      target,
      { content: 'Hi', components: [{ type: 10, content: 'x' }], flags: 32768 },
      { username: 'Bot', avatarUrl: 'https://example.com/a.png', silent: true },
    );
    expect(id).toBe('100000000000000050');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ method: 'POST', path: `/webhooks/${known.id}/${known.token}`, authorized: false });
    const query = new URLSearchParams(request!.query);
    expect(query.get('wait')).toBe('true');
    expect(query.get('with_components')).toBe('true');
    expect(query.get('thread_id')).toBe(THREAD);
    expect(request!.body).toMatchObject({
      content: 'Hi',
      username: 'Bot',
      avatar_url: 'https://example.com/a.png',
      allowed_mentions: { parse: [] },
      flags: 32768 | 4096,
    });
  });

  it('omits optional query parameters and honours allowed mentions', async () => {
    const { webhooks, requests } = setup(() => ({ status: 200, json: { id: '1' } }));
    await webhooks.send({ ...known, threadId: null }, { content: 'x', allowedMentions: { parse: [AllowedMentionsTypes.User] } });
    expect(requests[0]!.query).toBe('?wait=true');
    expect(requests[0]!.body).toMatchObject({ allowed_mentions: { parse: [AllowedMentionsTypes.User] } });
  });

  it('uploads files as multipart', async () => {
    const { webhooks, requests } = setup(() => ({ status: 200, json: { id: '1' } }));
    await webhooks.send({ ...known, threadId: null }, { content: 'x', files: [{ name: 'a.txt', data: Buffer.from('hello') }] });
    const body = requests[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('files[0]')).not.toBeNull();
  });

  it('redacts the token from errors and maps unknown webhooks', async () => {
    const failed = setup(() => ({ status: 500, json: { message: 'boom' } }));
    const failure = (await failed.webhooks.send({ ...known, threadId: null }, { content: 'x' }).catch((e: unknown) => e)) as Error & {
      url?: string;
    };
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure) + String(failure.url) + failure.message).not.toContain(known.token);
    for (const gone of [error(10015), error(50027, 401)]) {
      await expect(setup(() => gone).webhooks.send({ ...known, threadId: null }, { content: 'x' })).rejects.toBeInstanceOf(UnknownWebhookError);
    }
  });
});

describe('deleteMessage', () => {
  it('maps unknown messages and webhooks and passes the thread', async () => {
    const missing = setup(() => error(10008));
    await expect(missing.webhooks.deleteMessage({ ...known, threadId: THREAD }, '100000000000000050')).rejects.toBeInstanceOf(UnknownMessageError);
    expect(missing.requests[0]).toMatchObject({
      method: 'DELETE',
      path: `/webhooks/${known.id}/${known.token}/messages/100000000000000050`,
      query: `?thread_id=${THREAD}`,
      authorized: false,
    });
    await expect(setup(() => error(10015)).webhooks.deleteMessage({ ...known, threadId: null }, '1')).rejects.toBeInstanceOf(UnknownWebhookError);
  });
});

describe('webhook management', () => {
  it('finds tokens Discord reveals', async () => {
    const { webhooks } = setup(() => ({ status: 200, json: [{ id: 'a', token: 'shown' }, { id: 'b' }] }));
    expect(await webhooks.findWebhookToken(CHANNEL, 'a')).toBe('shown');
    expect(await webhooks.findWebhookToken(CHANNEL, 'b')).toBeNull();
  });

  it('treats unknown webhooks as deleted', async () => {
    const { webhooks, requests } = setup(() => error(10015));
    await webhooks.deleteWebhook(known);
    await webhooks.deleteWebhookById(known.id);
    expect(requests.map((r) => [r.method, r.path, r.authorized])).toEqual([
      ['DELETE', `/webhooks/${known.id}/${known.token}`, false],
      ['DELETE', `/webhooks/${known.id}`, true],
    ]);
  });

  it('keeps the token out of a refused deletion', async () => {
    const { webhooks } = setup(() => error(50027, 401));
    const failure = (await webhooks.deleteWebhook(known).catch((e: unknown) => e)) as Error & { url?: string };
    expect(JSON.stringify(failure) + String(failure.url) + failure.message).not.toContain(known.token);
  });
});
