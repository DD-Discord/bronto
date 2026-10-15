import { Collection, Events, Guild, type Client } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertGuild } from '../src/db/guilds.js';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes, type ModuleRuntime } from '../src/runtime/context.js';
import { Dispatcher, guildIdOf, type HandlerResult } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { defineEvent, on } from '../src/runtime/events.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import type { HandlerContext } from '../src/runtime/types.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

interface Seen {
  module: string;
  guildId: string;
  actorId: string | null;
  detail: unknown;
}

const counted = defineEvent<{ n: number }>('counted');
const seen: Seen[] = [];

const alpha = defineModule({
  name: 'alpha',
  events: { counted },
  listeners: [
    on(Events.MessageCreate, async (ctx, message) => {
      seen.push({ module: 'alpha', guildId: ctx.guildId, actorId: ctx.actorId, detail: message.id });
      if (message.content === 'fail') throw new Error('alpha failed');
      await ctx.db.run(async (tx) => {
        await tx.insert(widgetItems).values({ id: message.id, label: 'alpha' });
      });
    }),
  ],
});

const beta = defineModule({
  name: 'beta',
  listeners: [
    on(Events.MessageCreate, (ctx, message) => {
      seen.push({ module: 'beta', guildId: ctx.guildId, actorId: ctx.actorId, detail: message.id });
    }),
    on(counted, (ctx, payload) => {
      seen.push({ module: 'beta', guildId: ctx.guildId, actorId: ctx.actorId, detail: payload.n });
    }),
  ],
});

let t: TestDatabase;
let dispatcher: Dispatcher;
let enablement: ModuleEnablement;
let runtimes: ModuleRuntime[];
let lines: LogLine[];
const runtime = (name: string) => runtimes.find((candidate) => candidate.name === name)!;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values([{ id: 'g1' }, { id: 'g2' }]);
  const captured = captureLog();
  lines = captured.lines;
  enablement = new ModuleEnablement(t.database.admin);
  runtimes = createModuleRuntimes(
    [alpha, beta].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
    { client: {} as Client, database: t.database, log: captured.log },
  );
  dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(() => {
  seen.length = 0;
  lines.length = 0;
});

describe('Dispatcher', () => {
  it('lists the gateway events modules listen to', () => {
    expect(dispatcher.discordEvents()).toEqual(['messageCreate']);
  });

  it('runs gateway listeners with a context scoped to the event guild', async () => {
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm1', guildId: 'g1', content: '' }]);
    expect(seen).toEqual([
      { module: 'alpha', guildId: 'g1', actorId: null, detail: 'm1' },
      { module: 'beta', guildId: 'g1', actorId: null, detail: 'm1' },
    ]);
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'm1'));
    expect(row?.guildId).toBe('g1');
  });

  it('ignores gateway events outside a guild', async () => {
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'dm', guildId: null, content: '' }]);
    expect(seen).toEqual([]);
  });

  it('skips modules switched off in the guild', async () => {
    await enablement.set('g2', 'alpha', false);
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm2', guildId: 'g2', content: '' }]);
    expect(seen.map((entry) => entry.module)).toEqual(['beta']);
  });

  it('keeps other modules running when one handler fails', async () => {
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm3', guildId: 'g1', content: 'fail' }]);
    expect(seen.map((entry) => entry.module)).toEqual(['alpha', 'beta']);
    expect(lines).toContainEqual(
      expect.objectContaining({ module: 'alpha', msg: 'Handler failed', guildId: 'g1', handler: 'messageCreate' }),
    );
  });

  it('delivers emitted events after the handler succeeds', async () => {
    const result = await dispatcher.runHandler(runtime('alpha'), 'g1', 'u1', 'test', (ctx) => {
      ctx.emit(counted, { n: 1 });
    });
    expect(result).toEqual({ ok: true });
    await dispatcher.idle();
    expect(seen).toEqual([{ module: 'beta', guildId: 'g1', actorId: 'u1', detail: 1 }]);
  });

  it('drops emitted events when the handler fails afterwards', async () => {
    const error = new Error('late failure');
    const result = await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'test', (ctx) => {
      ctx.emit(counted, { n: 2 });
      throw error;
    });
    expect(result).toEqual({ ok: false, error });
    await dispatcher.idle();
    expect(seen).toEqual([]);
  });

  it("refuses to emit another module's event", async () => {
    const result = await dispatcher.runHandler(runtime('beta'), 'g1', null, 'test', (ctx) => {
      ctx.emit(counted, { n: 3 });
    });
    expect(result.ok).toBe(false);
    await dispatcher.idle();
    expect(seen).toEqual([]);
    const failure = lines.find((line) => line.module === 'beta' && line.msg === 'Handler failed');
    expect((failure?.err as { message: string }).message).toMatch(/cannot emit alpha\.counted/);
  });

  it('runs GuildDelete and GuildUnavailable listeners without waiting for the gate', async () => {
    const removed: string[] = [];
    const watcher = defineModule({
      name: 'watcher',
      listeners: [
        on(Events.GuildDelete, (ctx) => {
          removed.push(`delete:${ctx.guildId}`);
        }),
        on(Events.GuildUnavailable, (ctx) => {
          removed.push(`unavailable:${ctx.guildId}`);
        }),
      ],
    });
    const watcherRuntimes = createModuleRuntimes([{ packageName: '@test/watcher', definition: watcher, config: {} }], {
      client: {} as Client,
      database: t.database,
      log: captureLog().log,
    });
    const gate: string[] = [];
    const gated = new Dispatcher({
      runtimes: watcherRuntimes,
      database: t.database,
      enablement,
      queue: new KeyedQueue(() => undefined),
      guildGate: async (guildId) => {
        gate.push(guildId);
        return false;
      },
    });
    const guild = Object.assign(Object.create(Guild.prototype) as Guild, { id: 'g5' });
    await gated.handleDiscord(Events.GuildDelete, [guild]);
    await gated.handleDiscord(Events.GuildUnavailable, [guild]);
    expect(removed).toEqual(['delete:g5', 'unavailable:g5']);
    expect(gate).toEqual([]);
  });

  it('keeps GuildDelete and GuildUnavailable listeners of switched-off modules quiet after the cache was cleared', async () => {
    const removed: string[] = [];
    const watcher = defineModule({
      name: 'watcher',
      listeners: [
        on(Events.GuildDelete, (ctx) => {
          removed.push(`delete:${ctx.guildId}`);
        }),
        on(Events.GuildUnavailable, (ctx) => {
          removed.push(`unavailable:${ctx.guildId}`);
        }),
      ],
    });
    const watcherRuntimes = createModuleRuntimes([{ packageName: '@test/watcher', definition: watcher, config: {} }], {
      client: {} as Client,
      database: t.database,
      log: captureLog().log,
    });
    const gate: string[] = [];
    const gated = new Dispatcher({
      runtimes: watcherRuntimes,
      database: t.database,
      enablement,
      queue: new KeyedQueue(() => undefined),
      guildGate: async (guildId) => {
        gate.push(guildId);
        return true;
      },
    });
    await upsertGuild(t.database.admin, 'g6');
    await enablement.set('g6', 'watcher', false);
    enablement.forget('g6');
    const guild = Object.assign(Object.create(Guild.prototype) as Guild, { id: 'g6' });
    await gated.handleDiscord(Events.GuildUnavailable, [guild]);
    enablement.forget('g6');
    await gated.handleDiscord(Events.GuildDelete, [guild]);
    expect(removed).toEqual([]);
    expect(gate).toEqual([]);
  });

  it('runs no handlers for a guild the gate turns away', async () => {
    const gated = new Dispatcher({
      runtimes,
      database: t.database,
      enablement,
      queue: new KeyedQueue(() => undefined),
      guildGate: async (guildId) => guildId !== 'g1',
    });
    await gated.handleDiscord(Events.MessageCreate, [{ id: 'm10', guildId: 'g1', content: '' }]);
    expect(seen).toEqual([]);
    await gated.handleDiscord(Events.MessageCreate, [{ id: 'm11', guildId: 'g2', content: '' }]);
    expect(seen.map((entry) => entry.guildId)).toEqual(['g2']);
  });

  it('logs expected errors at debug level and others at error level', async () => {
    class Stop extends Error {}
    const expectedError = (error: unknown) => error instanceof Stop;
    const stopped: HandlerResult = await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'quiet', () => {
      throw new Stop('stop');
    }, { expectedError });
    const failed = await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'loud', () => {
      throw new Error('broken');
    }, { expectedError });
    expect(stopped.ok).toBe(false);
    expect(failed.ok).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ level: 20, msg: 'Handler stopped', handler: 'quiet' }));
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: 'Handler failed', handler: 'loud' }));
    expect(lines.filter((line) => line.handler === 'quiet' && line.level >= 50)).toEqual([]);
  });

  it('refuses emits after the handler finished', async () => {
    let saved: HandlerContext | undefined;
    await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'test', (ctx) => {
      saved = ctx;
    });
    expect(() => saved?.emit(counted, { n: 4 })).toThrow(
      'Module "alpha" emitted alpha.counted after its handler finished; emit inside the handler or a queued task.',
    );
  });

  it('runs queued tasks as handlers of the requesting guild and actor', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const ran: Array<{ step: string; guildId: string; actorId: string | null }> = [];
    const enqueue = (guildId: string, actorId: string, step: string, wait = false) =>
      dispatcher.runHandler(runtime('alpha'), guildId, actorId, 'test', (ctx) => {
        void ctx.queue.run('shared', async (task) => {
          if (wait) await blocked;
          ran.push({ step, guildId: task.guildId, actorId: task.actorId });
          task.emit(counted, { n: ran.length });
        });
      });
    await enqueue('g1', 'u1', 'A', true);
    await enqueue('g1', 'u2', 'B');
    await enqueue('g2', 'u3', 'C');
    await vi.waitFor(() => expect(ran.map((entry) => entry.step)).toEqual(['C']));
    release();
    await dispatcher.idle();
    expect(ran).toEqual([
      { step: 'C', guildId: 'g2', actorId: 'u3' },
      { step: 'A', guildId: 'g1', actorId: 'u1' },
      { step: 'B', guildId: 'g1', actorId: 'u2' },
    ]);
    expect(seen.filter((entry) => entry.module === 'beta')).toEqual([
      { module: 'beta', guildId: 'g2', actorId: 'u3', detail: 1 },
      { module: 'beta', guildId: 'g1', actorId: 'u1', detail: 2 },
      { module: 'beta', guildId: 'g1', actorId: 'u2', detail: 3 },
    ]);
  });

  it('keys queued tasks by module, guild and key', async () => {
    const queue = new KeyedQueue(() => undefined);
    const run = vi.spyOn(queue, 'run');
    const keyed = new Dispatcher({ runtimes, database: t.database, enablement, queue });
    await keyed.runHandler(runtime('alpha'), 'g2', null, 'test', async (ctx) => {
      await ctx.queue.run('channel-1', async () => undefined);
    });
    expect(run).toHaveBeenCalledWith('alpha/g2/channel-1', expect.any(Function));
  });

  it('logs failing queued tasks on the module logger', async () => {
    await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'test', (ctx) => {
      void ctx.queue.run('broken', async () => {
        throw new Error('queued failure');
      });
    });
    await dispatcher.idle();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, module: 'alpha', msg: 'Handler failed', guildId: 'g1', handler: 'queue:broken' }),
    );
  });

  it('finds the guild in the second argument when the first has none', async () => {
    const guild = Object.assign(Object.create(Guild.prototype) as Guild, { id: 'g1' });
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm9', guildId: null, content: '' }, guild]);
    expect(seen.map((entry) => entry.guildId)).toEqual(['g1', 'g1']);
  });
});

describe('guildIdOf', () => {
  it.each([
    [{ guildId: 'g1' }, 'g1'],
    [{ guild: { id: 'g2' } }, 'g2'],
    [{ message: { guildId: 'g3' } }, 'g3'],
    [{ guildId: null }, null],
    [{ id: 'user' }, null],
    [undefined, null],
  ])('finds the guild of %j', (value, expected) => {
    expect(guildIdOf(value)).toBe(expected);
  });

  it('reads the id of a Guild', () => {
    const guild = Object.assign(Object.create(Guild.prototype) as Guild, { id: 'g5' });
    expect(guildIdOf(guild)).toBe('g5');
  });

  it('reads the guild of the first item of a Collection', () => {
    expect(guildIdOf(new Collection([['m1', { guildId: 'g6' }]]))).toBe('g6');
    expect(guildIdOf(new Collection())).toBeNull();
  });
});
