import { Client, ClientUser, Events, type APIUser, type ClientApplication } from 'discord.js';
import type { FakeDiscordHttp } from './discord-http.js';
import { fakeTransport, type RecordedRequest } from './rest.js';

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
  client.user = new TestUser(client, http.users.get(http.botId)!);
  client.application = { id: http.applicationId } as ClientApplication;
  client.login = async token => {
    client.token = token ?? 'synthetic-token';
    client.rest.setToken(client.token);
    return client.token;
  };
  Object.defineProperty(client.ws, 'connect', { value: async () => { throw new Error('Gateway connections are disabled in tests'); }, configurable: true });
  client.rest.setToken('synthetic-token');
  try {
    for (const guildId of http.guildIds) await client.guilds.fetch(guildId);
  } catch (error) {
    await client.destroy();
    throw error;
  }
  return { client, requests: transport.requests, ready() { client.readyTimestamp = Date.now(); client.emit(Events.ClientReady, client as Client<true>); } };
}
