import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';

/** Stands in for the discord.js client; tests emit gateway events on it directly. */
export class FakeClient extends EventEmitter {
  readonly guilds = { cache: new Map<string, { id: string; available: boolean }>() };
  readonly rest = {
    setToken: (token: string) => {
      this.restToken = token;
    },
  };
  loggedInWith: string | null = null;
  restToken: string | null = null;
  destroyed = false;

  async login(token: string): Promise<string> {
    this.loggedInWith = token;
    return token;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  asClient(): Client {
    return this as unknown as Client;
  }
}
