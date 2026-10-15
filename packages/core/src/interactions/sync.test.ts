import { REST, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { captureLog } from '../testing/log.js';
import { CommandSync, commandsEqual, restCommandRegistry, type CommandJson, type CommandRegistry } from './sync.js';

const desired: CommandJson[] = [
  {
    type: 1,
    name: 'notes',
    description: 'Notes',
    default_member_permissions: '8192',
    nsfw: false,
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Creates',
        options: [
          { type: 3, name: 'title', description: 'Title', required: true, max_length: 100 },
          { type: 7, name: 'where', description: 'Where', required: false, channel_types: [5, 0] },
        ],
      },
    ],
  },
  { type: 1, name: 'modules', description: 'Modules', default_member_permissions: '8', nsfw: false, options: [] },
];

// What Discord returns for the same commands: extra fields, defaults left out, a different command order.
const registered = [
  { id: '2', application_id: 'app-1', guild_id: 'g1', version: '9', type: 1, name: 'modules', description: 'Modules', default_member_permissions: '8', dm_permission: true, contexts: null, integration_types: [0], nsfw: false },
  {
    id: '1',
    application_id: 'app-1',
    guild_id: 'g1',
    version: '7',
    type: 1,
    name: 'notes',
    description: 'Notes',
    default_member_permissions: '8192',
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Creates',
        options: [
          { type: 3, name: 'title', description: 'Title', required: true, max_length: 100 },
          { type: 7, name: 'where', description: 'Where', channel_types: [0, 5] },
        ],
      },
    ],
  },
];

describe('commandsEqual', () => {
  it('ignores what Discord adds and defaults it leaves out', () => {
    expect(commandsEqual(registered, desired)).toBe(true);
  });

  it('notices changes bronto makes', () => {
    const changed = (edit: (commands: CommandJson[]) => void) => {
      const copy = structuredClone(desired);
      edit(copy);
      return commandsEqual(registered, copy);
    };
    expect(changed((c) => (c[1]!.description = 'Other'))).toBe(false);
    expect(changed((c) => (c[1]!.default_member_permissions = null))).toBe(false);
    expect(changed((c) => c.pop())).toBe(false);
    expect(changed((c) => (c[0]!.options![0] as { options: unknown[] }).options.reverse())).toBe(false);
    expect(changed((c) => ((c[0]!.options![0] as { options: Array<{ required?: boolean }> }).options[1]!.required = true))).toBe(false);
  });
});

function memoryRegistry(initial: unknown[] = []) {
  const state = { commands: initial, fetches: 0, writes: [] as CommandJson[][] };
  let release: (() => void) | null = null;
  const registry: CommandRegistry = {
    async fetch() {
      state.fetches += 1;
      if (release === null && state.fetches === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return state.commands;
    },
    async overwrite(_guildId, commands) {
      state.writes.push(commands);
      state.commands = commands;
    },
  };
  return { state, registry, release: () => release?.() };
}

describe('CommandSync', () => {
  it('overwrites only when the commands differ', async () => {
    const { log } = captureLog();
    const writes: CommandJson[][] = [];
    let current: unknown[] = registered;
    const sync = new CommandSync({
      log,
      desired: () => desired,
      registry: {
        fetch: async () => current,
        overwrite: async (_guildId, commands) => {
          writes.push(commands);
          current = commands;
        },
      },
    });
    await sync.sync('g1');
    expect(writes).toEqual([]);
    current = [];
    await sync.sync('g1');
    expect(writes).toEqual([desired]);
  });

  it('collapses a burst into the running sync and one more with the latest commands', async () => {
    const { log } = captureLog();
    const memory = memoryRegistry();
    let version = 0;
    const sync = new CommandSync({
      log,
      registry: memory.registry,
      desired: () => [{ ...desired[1]!, description: `v${version}` }],
    });
    const first = sync.sync('g1');
    version = 1;
    const second = sync.sync('g1');
    version = 2;
    const third = sync.sync('g1');
    memory.release();
    await Promise.all([first, second, third]);
    expect(memory.state.fetches).toBe(2);
    expect(memory.state.writes.map((commands) => commands[0]!.description)).toEqual(['v0', 'v2']);
  });

  it('logs failures instead of rejecting', async () => {
    const { log, lines } = captureLog();
    const sync = new CommandSync({
      log,
      desired: () => desired,
      registry: {
        fetch: async () => {
          throw new Error('Missing Access');
        },
        overwrite: async () => undefined,
      },
    });
    await expect(sync.sync('g9')).resolves.toBeUndefined();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, msg: 'Updating the commands of a guild failed', guildId: 'g9' }),
    );
  });
});

describe('restCommandRegistry', () => {
  it('sends the bulk overwrite and the fetch to the guild commands route', async () => {
    const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const rest = new REST({
      makeRequest: async (url, init) => {
        requests.push({ url, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
        const text = JSON.stringify(init.method === 'GET' ? registered : desired);
        return {
          body: null,
          bodyUsed: false,
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => text,
          json: async () => JSON.parse(text),
          arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        } as never;
      },
    }).setToken('token');
    const registry = restCommandRegistry({ rest, application: { id: 'app-1' } } as unknown as Client);
    expect(await registry.fetch('g1')).toEqual(registered);
    await registry.overwrite('g1', desired);
    expect(requests).toEqual([
      { url: 'https://discord.com/api/v10/applications/app-1/guilds/g1/commands', method: 'GET', body: null },
      { url: 'https://discord.com/api/v10/applications/app-1/guilds/g1/commands', method: 'PUT', body: desired },
    ]);
  });

  it('needs a ready client', async () => {
    const registry = restCommandRegistry({ rest: new REST(), application: null } as unknown as Client);
    await expect(registry.fetch('g1')).rejects.toThrow('The client is not ready; its application ID is unknown.');
  });
});
