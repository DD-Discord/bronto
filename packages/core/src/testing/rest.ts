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

export type FakeHttpAnswer = (request: RecordedRequest) => FakeRestAnswer | Promise<FakeRestAnswer>;

/** Intercepts every HTTP request, including native Discord.js manager calls. */
export function fakeTransport(answer: FakeHttpAnswer): {
  options: Pick<import('discord.js').RESTOptions, 'makeRequest' | 'retries'>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    options: {
      retries: 0,
      makeRequest: async (url, init) => {
        const parsed = new URL(url);
        const request: RecordedRequest = {
          method: init.method ?? 'GET', path: parsed.pathname.replace('/api/v10', ''), query: parsed.search,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof FormData ? init.body : undefined,
          authorized: new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).has('authorization'),
        };
        requests.push(request);
        const { status, json } = await answer(request);
        return new Response(status === 204 ? null : JSON.stringify(json), {
          status, headers: status === 204 ? {} : { 'content-type': 'application/json' },
        });
      },
    },
  };
}

/** A standalone REST client for tests that do not need native managers. */
export function fakeRest(answer: (method: string, path: string) => FakeRestAnswer): { rest: REST; requests: RecordedRequest[] } {
  const { options, requests } = fakeTransport(request => answer(request.method, request.path));
  return { rest: new REST(options).setToken('bot-token'), requests };
}
