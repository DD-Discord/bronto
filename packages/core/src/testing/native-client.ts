import { createRequire } from 'node:module';
import { Client, ClientUser, Events, type APIUser, type ClientApplication } from 'discord.js';
import type { FakeDiscordHttp } from './discord-http.js';
import { fakeTransport, type RecordedRequest } from './rest.js';

interface DownloadBlocker { disableNetConnect(): void; close(): Promise<void>; }
interface UndiciControls {
  getGlobalDispatcher(): object;
  setGlobalDispatcher(dispatcher: object): void;
  MockAgent: new () => DownloadBlocker;
}

// Use the same Undici instance Discord.js uses for URL attachment downloads, without adding a dependency.
const undici = createRequire(import.meta.resolve('discord.js'))('undici') as UndiciControls;
let downloads: { agent: DownloadBlocker; previous: object; users: number } | undefined;

function blockDownloads(): () => Promise<void> {
  if (!downloads || undici.getGlobalDispatcher() !== downloads.agent) {
    const agent = new undici.MockAgent();
    agent.disableNetConnect();
    downloads = { agent, previous: undici.getGlobalDispatcher(), users: 0 };
    undici.setGlobalDispatcher(agent);
  }
  const scope = downloads;
  scope.users += 1;
  return async () => {
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
  const releaseDownloads = blockDownloads();
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
