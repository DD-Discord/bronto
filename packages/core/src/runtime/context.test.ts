import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { captureLog } from '../testing/log.js';
import { runInScope } from '../db/context.js';
import type { Database } from '../db/database.js';
import { createModuleRuntimes, type RuntimeServices } from './context.js';
import type { LoadedModule } from './loader.js';
import { defineModule, type ModuleDefinition } from './module.js';

const loaded = (definition: ModuleDefinition, config: unknown = {}): LoadedModule => ({
  packageName: `@test/${definition.name}`,
  definition,
  config,
});

function services(): RuntimeServices & { lines: ReturnType<typeof captureLog>['lines'] } {
  const { log, lines } = captureLog();
  return {
    client: {} as Client,
    database: { app: {} } as unknown as Database,
    log,
    lines,
  };
}

const counter = defineModule({ name: 'counter', api: () => ({ next: (n: number) => n + 1 }) });
const plain = defineModule({ name: 'plain' });

describe('createModuleRuntimes', () => {
  it('gives each module its config and a logger named after it', () => {
    const shared = services();
    const [runtime] = createModuleRuntimes([loaded(plain, { greeting: 'hi' })], shared);
    expect(runtime?.context.config).toEqual({ greeting: 'hi' });
    runtime?.context.log.info('hello');
    expect(shared.lines[0]).toMatchObject({ module: 'plain', msg: 'hello' });
  });

  it('leaves the queue to handler contexts', () => {
    const [runtime] = createModuleRuntimes([loaded(plain)], services());
    expect(runtime?.context).not.toHaveProperty('queue');
  });

  it('gives a module the APIs of its dependencies', () => {
    const user = defineModule({ name: 'api_user', dependsOn: [counter] });
    const [, runtime] = createModuleRuntimes([loaded(counter), loaded(user)], services());
    expect(runtime?.context.modules.get(counter).next(1)).toBe(2);
  });

  it('refuses APIs of modules that are not declared dependencies', () => {
    const stranger = defineModule({ name: 'stranger' });
    const [, runtime] = createModuleRuntimes([loaded(counter), loaded(stranger)], services());
    expect(() => runtime?.context.modules.get(counter)).toThrow(
      'Module "stranger" must list "counter" in dependsOn to use its API.',
    );
  });

  it('refuses dependencies without an API', () => {
    const user = defineModule({ name: 'plain_user', dependsOn: [plain] });
    const [, runtime] = createModuleRuntimes([loaded(plain), loaded(user)], services());
    expect(() => runtime?.context.modules.get(plain)).toThrow('Module "plain" has no API.');
  });

  it('builds APIs in dependency order so they can use other APIs', () => {
    const doubler = defineModule({
      name: 'doubler',
      dependsOn: [counter],
      api: (ctx) => ({ twice: (n: number) => ctx.modules.get(counter).next(ctx.modules.get(counter).next(n)) }),
    });
    const [, runtime] = createModuleRuntimes([loaded(counter), loaded(doubler)], services());
    expect((runtime?.api as { twice: (n: number) => number }).twice(1)).toBe(3);
  });

  it('gives APIs database access for the calling guild only', () => {
    let db: (() => { guildId: string }) | undefined;
    const reader = defineModule({
      name: 'reader',
      api: (ctx) => {
        db = ctx.db;
        return {};
      },
    });
    createModuleRuntimes([loaded(reader)], services());
    expect(() => db?.()).toThrow('A module API used the database outside a guild handler.');
    expect(runInScope({ guildId: 'g1' }, () => db?.().guildId)).toBe('g1');
  });
});
