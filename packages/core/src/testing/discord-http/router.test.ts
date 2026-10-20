import { expect, it } from 'vitest';
import { createRouter, route } from './router.js';
import type { RecordedRequest } from '../rest.js';

const request = (method: string, path: string, query = ''): RecordedRequest => ({
  method, path, query, body: { content: 'Synthetic message' }, authorized: true,
});

const answer = createRouter([
  route('GET', '/health', () => ({ status: 200, json: { healthy: true } })),
  route('GET', '/channels/:channelId/messages/:messageId', (request, params) => ({
    status: 200, json: { channel: params.channelId, message: params.messageId, query: request.query },
  })),
  route('POST', '/channels/:channelId/messages/:messageId', async request => ({
    status: 201, json: request.body,
  })),
  route('GET', '/webhooks/:webhookId/:token', (_request, params) => ({ status: 200, json: params })),
]);

it('matches complete paths and passes named parameters separately from the query', async () => {
  expect(await answer(request('GET', '/health'))).toEqual({ status: 200, json: { healthy: true } });
  expect(await answer(request('GET', '/channels/123/messages/456', '?around=789')))
    .toEqual({ status: 200, json: { channel: '123', message: '456', query: '?around=789' } });
});

it('distinguishes methods on the same path and awaits asynchronous handlers', async () => {
  expect(await answer(request('POST', '/channels/123/messages/456')))
    .toEqual({ status: 201, json: { content: 'Synthetic message' } });
});

it('decodes captured parameters after matching path segments', async () => {
  expect(await answer(request('GET', '/webhooks/123/synthetic%2Ftoken')))
    .toEqual({ status: 200, json: { webhookId: '123', token: 'synthetic/token' } });
});

it.each([
  ['POST', '/health'],
  ['GET', '/health/more'],
  ['GET', '/health/'],
  ['GET', '/channels/123/messages'],
  ['GET', '/channels//messages/456'],
  ['GET', '/unknown'],
])('fails locally for an unmatched method or path: %s %s', async (method, path) => {
  await expect(answer(request(method, path))).rejects.toThrow(`Unexpected Discord request: ${method} ${path}`);
});
