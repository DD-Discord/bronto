import { createRequire } from 'node:module';
import { Client, ClientUser, Events, type APIUser, type ClientApplication } from 'discord.js';
import type { FakeDiscordHttp } from './discord-http.js';
import { fakeTransport, type RecordedRequest } from './rest.js';

interface Interceptor { reply(callback: (options: { path: string }) => unknown): { persist(): void } }
interface DownloadBlocker {
  disableNetConnect(): void;
  close(): Promise<void>;
  get(origin: string): { intercept(options: { path: (path: string) => boolean; method: string }): Interceptor };
}
interface UndiciControls {
  getGlobalDispatcher(): object;
  setGlobalDispatcher(dispatcher: object): void;
  MockAgent: new () => DownloadBlocker;
}

// Use the same Undici instance Discord.js uses for URL attachment downloads, without adding a dependency. Its global
// dispatcher is the one Node's global `fetch` uses too, so both are blocked and both reach the fake CDN.
const undici = createRequire(import.meta.resolve('discord.js'))('undici') as UndiciControls;
let downloads: { agent: DownloadBlocker; previous: object; users: number; sources: FakeDiscordHttp[] } | undefined;

const CDN = 'https://cdn.discordapp.com';

/** Answers `/attachments/<channel>/<id>/<name>?ex=…` from the stored files of the registered fakes. */
function serveAttachment(sources: FakeDiscordHttp[], requestPath: string) {
  const notFound = { statusCode: 404, data: 'This content is no longer available.' };
  const url = new URL(requestPath, CDN);
  const [, , channelId, id, name] = url.pathname.split('/');
  const expires = Number.parseInt(url.searchParams.get('ex') ?? '', 16);
  if (!(expires * 1000 > Date.now())) return notFound;
  for (const http of sources) {
    const file = http.files.get(id ?? '');
    if (file && file.channelId === channelId && encodeURIComponent(file.filename) === name) {
      return { statusCode: 200, data: file.data, responseOptions: { headers: { 'content-type': file.contentType } } };
    }
  }
  return notFound;
}

function blockDownloads(http: FakeDiscordHttp): () => Promise<void> {
  if (!downloads || undici.getGlobalDispatcher() !== downloads.agent) {
    const agent = new undici.MockAgent();
    agent.disableNetConnect();
    const sources: FakeDiscordHttp[] = [];
    agent.get(CDN).intercept({ path: path => path.startsWith('/attachments/'), method: 'GET' })
      .reply(options => serveAttachment(sources, options.path)).persist();
    downloads = { agent, previous: undici.getGlobalDispatcher(), users: 0, sources };
    undici.setGlobalDispatcher(agent);
  }
  const scope = downloads;
  scope.users += 1;
  scope.sources.push(http);
  return async () => {
    scope.sources.splice(scope.sources.indexOf(http), 1);
    scope.users -= 1;
    if (scope.users !== 0) return;
    if (undici.getGlobalDispatcher() === scope.agent) undici.setGlobalDispatcher(scope.previous);
    if (downloads === scope) downloads = undefined;
    await scope.agent.close();
  };
}

class TestUser extends ClientUser {
  constructor(client: Client, data: APIUser) { super(client as Client<true>, data); }
}

export interface NativeTestClient {
  client: Client & { emit(event: string, ...args: unknown[]): boolean };
  requests: RecordedRequest[];
  ready(): void;
}

/** Real managers and objects, with local login/readiness and an HTTP transport that cannot reach Discord. */
export async function createNativeTestClient(http: FakeDiscordHttp): Promise<NativeTestClient> {
  const transport = fakeTransport(http.answer);
  const client = new Client({ intents: [], rest: { ...transport.options, offset: 0, globalRequestsPerSecond: Infinity } }) as NativeTestClient['client'];
  const releaseDownloads = blockDownloads(http);
  const destroy = client.destroy.bind(client);
  let destroying: Promise<void> | undefined;
  client.destroy = () => destroying ??= (async () => {
    try { await destroy(); }
    finally { await releaseDownloads(); }
  })();
  try {
    client.user = new TestUser(client, http.users.get(http.botId)!);
    client.application = { id: http.applicationId } as ClientApplication;
    client.login = async token => {
      client.token = token ?? 'synthetic-token';
      client.rest.setToken(client.token);
      return client.token;
    };
    Object.defineProperty(client.ws, 'connect', { value: async () => { throw new Error('Gateway connections are disabled in tests'); }, configurable: true });
    client.rest.setToken('synthetic-token');
    for (const guildId of http.guildIds) await client.guilds.fetch(guildId);
  } catch (error) {
    await client.destroy();
    throw error;
  }
  return { client, requests: transport.requests, ready() { client.readyTimestamp = Date.now(); client.emit(Events.ClientReady, client as Client<true>); } };
}
