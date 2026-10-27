import type { Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes, type ModuleRuntime } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { defineModule, type ModuleDefinition } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { captureLog } from '../src/testing/log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const provider = defineModule({ name: 'provider', api: () => ({ hello: () => 'hi' }) });
const bare = defineModule({ name: 'bare' });
const other = defineModule({ name: 'other', api: () => ({}) });
const consumer = defineModule({
  name: 'consumer',
  optionalDependsOn: [provider, bare],
  api: (ctx) => ({
    provider: () => ctx.modules.optional(provider),
    bare: () => ctx.modules.optional(bare),
    unlisted: () => ctx.modules.optional(other),
    hard: () => ctx.modules.get(provider),
  }),
});

const load = (definitions: ModuleDefinition<any, any>[], database: TestDatabase['database'], enablement?: ModuleEnablement) =>
  createModuleRuntimes(
    definitions.map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
    { client: {} as Client, database, log: captureLog().log, enablement },
  );

let t: TestDatabase;
let enablement: ModuleEnablement;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values([{ id: 'g1' }, { id: 'g2' }]);
  enablement = new ModuleEnablement(t.database.admin);
});

afterAll(async () => {
  await t.drop();
});

function caller(runtimes: ModuleRuntime[], withEnablement = true) {
  const dispatcher = new Dispatcher({
    runtimes,
    database: t.database,
    enablement: withEnablement ? enablement : new ModuleEnablement(t.database.admin),
    queue: new KeyedQueue(() => undefined),
  });
  const self = runtimes.find((runtime) => runtime.name === 'consumer')!;
  return async <T>(guildId: string, call: (api: any) => T): Promise<T> => {
    let out: T | undefined;
    const result = await dispatcher.runHandler(self, guildId, null, 'test', async () => {
      out = call(self.api);
    });
    if (!result.ok) throw result.error;
    return out as T;
  };
}

describe('ctx.modules.optional', () => {
  it('returns null when the dependency is not loaded', async () => {
    const run = caller(load([consumer], t.database, enablement));
    expect(await run('g1', (api) => api.provider())).toBeNull();
  });

  it('returns null when the dependency is off in the guild and the API when on', async () => {
    const run = caller(load([provider, consumer], t.database, enablement));
    await enablement.set('g1', 'provider', false);
    expect(await run('g1', (api) => api.provider())).toBeNull();
    await enablement.set('g1', 'provider', true);
    expect((await run('g1', (api) => api.provider())).hello()).toBe('hi');
  });

  it('follows the caller\'s guild', async () => {
    const run = caller(load([provider, consumer], t.database, enablement));
    await enablement.set('g1', 'provider', true);
    await enablement.set('g2', 'provider', false);
    expect(await run('g1', (api) => api.provider())).not.toBeNull();
    expect(await run('g2', (api) => api.provider())).toBeNull();
  });

  it('counts everything as enabled without an enablement service', async () => {
    const run = caller(load([provider, consumer], t.database), false);
    expect(await run('g1', (api) => api.provider())).not.toBeNull();
  });

  it('rejects an unlisted module', async () => {
    const run = caller(load([other, consumer], t.database, enablement));
    await expect(run('g1', (api) => api.unlisted())).rejects.toThrow(
      'Module "consumer" must list "other" in optionalDependsOn to use it optionally.',
    );
  });

  it('rejects a loaded dependency without an API', async () => {
    const run = caller(load([bare, consumer], t.database, enablement));
    await expect(run('g1', (api) => api.bare())).rejects.toThrow('Module "bare" has no API.');
    await enablement.set('g1', 'bare', false);
    await expect(run('g1', (api) => api.bare())).rejects.toThrow('Module "bare" has no API.');
    await enablement.set('g1', 'bare', true);
  });

  it('keeps get strict for optional-only dependencies', async () => {
    const run = caller(load([provider, consumer], t.database, enablement));
    await expect(run('g1', (api) => api.hard())).rejects.toThrow(
      'Module "consumer" must list "provider" in dependsOn to use its API.',
    );
  });

  it('throws outside a handler', () => {
    const [runtime] = load([provider, consumer], t.database, enablement).filter((r) => r.name === 'consumer');
    expect(() => (runtime!.api as any).provider()).toThrow('A module API was used outside a handler.');
  });
});
