import { REST } from 'discord.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  /** The parsed JSON body, or the FormData of a multipart request. */
  body: unknown;
  authorized: boolean;
}

export interface FakeRestAnswer {
  status: number;
  json: unknown;
}

/** A REST client whose requests go to `answer` instead of Discord; every request is recorded. */
export function fakeRest(answer: (method: string, path: string) => FakeRestAnswer): { rest: REST; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const rest = new REST({
    retries: 0,
    makeRequest: async (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/api/v10', '');
      requests.push({
        method: init.method ?? 'GET',
        path,
        query: parsed.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof FormData ? init.body : undefined,
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
  return { rest, requests };
}
