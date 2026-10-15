import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';

const COMMANDS_ROUTE = /^\/applications\/app-1\/guilds\/([\w-]+)\/commands$/;

function guildOf(route: string): string {
  const match = COMMANDS_ROUTE.exec(route);
  if (match === null) throw new Error(`FakeClient does not support the route ${route}`);
  return match[1]!;
}

/** Stands in for the discord.js client; tests emit gateway events on it directly. */
export class FakeClient extends EventEmitter {
  readonly guilds = { cache: new Map<string, { id: string; available: boolean }>() };
  readonly application = { id: 'app-1' };
  /** Guild commands as the fake Discord API stores them, per guild ID. */
  readonly registered = new Map<string, unknown[]>();
  /** Every bulk overwrite of a guild's commands, in order. */
  readonly commandWrites: Array<{ guildId: string; body: unknown[] }> = [];
  readonly rest = {
    setToken: (token: string) => {
      this.restToken = token;
    },
    get: async (route: string): Promise<unknown[]> => this.registered.get(guildOf(route)) ?? [],
    put: async (route: string, options: { body: unknown[] }): Promise<unknown[]> => {
      const guildId = guildOf(route);
      this.commandWrites.push({ guildId, body: options.body });
      this.registered.set(guildId, options.body);
      return options.body;
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
