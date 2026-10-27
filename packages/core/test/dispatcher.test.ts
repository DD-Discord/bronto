import { Collection, Events, GatewayDispatchEvents, Guild, type Client } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertGuild } from '../src/db/guilds.js';
import { checkCustomId, defineButton } from '../src/interactions/components.js';
import { ComponentSigner } from '../src/interactions/signing.js';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes, type ModuleRuntime } from '../src/runtime/context.js';
import { Dispatcher, guildIdOf, type HandlerResult } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { defineEvent, gatewayEvent, on } from '../src/runtime/events.js';
import { answer, COLLECTOR_TIMEOUT_MS, defineCollector, type Collected } from '../src/runtime/asks.js';
import { defineGate, gate, GATE_TIMEOUT_MS, type GateResult, type GateVerdict } from '../src/runtime/gates.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import type { HandlerContext } from '../src/runtime/types.js';
import { widgetsMigrations } from './fixtures/widgets/module.js';
import * as widgetsSchema from './fixtures/widgets/schema.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

interface Seen {
  module: string;
  guildId: string;
  actorId: string | null;
  detail: unknown;
}

const threadDelete = gatewayEvent(GatewayDispatchEvents.ThreadDelete);
const counted = defineEvent<{ n: number }>('counted');
const signer = new ComponentSigner('s'.repeat(32));
const tap = defineButton({ name: 'tap', execute: () => undefined });
const own = defineButton({ name: 'own', bind: { user: true }, execute: () => undefined });
const seen: Seen[] = [];

// Owns the widgets schema, so its handlers can write widget items.
const widgets = defineModule({
  name: 'widgets',
  db: { schema: widgetsSchema, migrations: widgetsMigrations },
  events: { counted },
  components: [tap, own],
  listeners: [
    on(threadDelete, (ctx, data) => {
      seen.push({ module: 'widgets', guildId: ctx.guildId, actorId: ctx.actorId, detail: data.id });
    }),
    on(Events.MessageCreate, async (ctx, message) => {
      seen.push({ module: 'widgets', guildId: ctx.guildId, actorId: ctx.actorId, detail: message.id });
      if (message.content === 'fail') throw new Error('widgets failed');
      await ctx.db.run(async (tx) => {
        await tx.insert(widgetItems).values({ id: message.id, label: 'widgets' });
      });
    }),
  ],
});

const beta = defineModule({
  name: 'beta',
  listeners: [
    on(threadDelete, (ctx, data) => {
      seen.push({ module: 'beta', guildId: ctx.guildId, actorId: ctx.actorId, detail: data.id });
    }),
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
    [widgets, beta].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
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
      { module: 'widgets', guildId: 'g1', actorId: null, detail: 'm1' },
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
    await enablement.set('g2', 'widgets', false);
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm2', guildId: 'g2', content: '' }]);
    expect(seen.map((entry) => entry.module)).toEqual(['beta']);
  });

  it('keeps other modules running when one handler fails', async () => {
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm3', guildId: 'g1', content: 'fail' }]);
    expect(seen.map((entry) => entry.module)).toEqual(['widgets', 'beta']);
    expect(lines).toContainEqual(
      expect.objectContaining({ module: 'widgets', msg: 'Handler failed', guildId: 'g1', handler: 'messageCreate' }),
    );
  });

  it('passes guild and actor to listeners of an event emitted outside a transaction', async () => {
    const result = await dispatcher.runHandler(runtime('widgets'), 'g1', 'u1', 'test', (ctx) => {
      ctx.emit(counted, { n: 1 });
    });
    expect(result).toEqual({ ok: true });
    await dispatcher.idle();
    expect(seen).toEqual([{ module: 'beta', guildId: 'g1', actorId: 'u1', detail: 1 }]);
  });

  it('delivers an event emitted in a transaction once it commits', async () => {
    const order: string[] = [];
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      await ctx.db.run(async () => {
        ctx.emit(counted, { n: 1 });
        order.push(`in transaction: ${seen.length}`);
      });
      order.push(`after commit: ${seen.length}`);
      throw new Error('later failure');
    });
    await dispatcher.idle();
    expect(order).toEqual(['in transaction: 0', 'after commit: 1']);
    expect(seen.map((entry) => entry.detail)).toEqual([1]);
  });

  it('drops events of a transaction that rolls back', async () => {
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      await ctx
        .db.run(async () => {
          ctx.emit(counted, { n: 2 });
          throw new Error('rollback');
        })
        .catch(() => undefined);
    });
    await dispatcher.idle();
    expect(seen).toEqual([]);
  });

  it('delivers events of a nested run with the innermost transaction', async () => {
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      await ctx
        .db.run(async () => {
          await ctx.db.run(async () => {
            ctx.emit(counted, { n: 5 });
          });
          ctx.emit(counted, { n: 6 });
          throw new Error('outer rollback');
        })
        .catch(() => undefined);
    });
    await dispatcher.idle();
    expect(seen.map((entry) => entry.detail)).toEqual([5]);
  });

  it('delivers an event emitted after its transaction settled at once', async () => {
    const emitLater: Array<() => void> = [];
    const result = await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      await ctx.db.run(async () => {
        emitLater.push(() => ctx.emit(counted, { n: 7 }));
      });
      await ctx.db
        .run(async () => {
          emitLater.push(() => ctx.emit(counted, { n: 8 }));
          throw new Error('rollback');
        })
        .catch(() => undefined);
      for (const emit of emitLater) emit();
    });
    expect(result).toEqual({ ok: true });
    await dispatcher.idle();
    expect(seen.map((entry) => entry.detail)).toEqual([7, 8]);
  });

  it('drops an event emitted while its transaction is open when it rolls back', async () => {
    const result = await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      await ctx
        .db.run(async () => {
          setTimeout(() => ctx.emit(counted, { n: 9 }), 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('rollback');
        })
        .catch(() => undefined);
    });
    expect(result).toEqual({ ok: true });
    await dispatcher.idle();
    expect(seen).toEqual([]);
  });

  it('delivers an event emitted outside a transaction at once', async () => {
    let seenDuringHandler = -1;
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', async (ctx) => {
      ctx.emit(counted, { n: 3 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      seenDuringHandler = seen.length;
    });
    expect(seenDuringHandler).toBe(1);
  });

  it("refuses to emit another module's event", async () => {
    const result = await dispatcher.runHandler(runtime('beta'), 'g1', null, 'test', (ctx) => {
      ctx.emit(counted, { n: 3 });
    });
    expect(result.ok).toBe(false);
    await dispatcher.idle();
    expect(seen).toEqual([]);
    const failure = lines.find((line) => line.module === 'beta' && line.msg === 'Handler failed');
    expect((failure?.err as { message: string }).message).toMatch(/cannot emit widgets\.counted/);
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
    const stopped: HandlerResult = await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'quiet', () => {
      throw new Stop('stop');
    }, { expectedError });
    const failed = await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'loud', () => {
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
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', (ctx) => {
      saved = ctx;
    });
    expect(() => saved?.emit(counted, { n: 4 })).toThrow(
      'Module "widgets" emitted widgets.counted after its handler finished; emit inside the handler or a queued task.',
    );
  });

  it('runs queued tasks as handlers of the requesting guild and actor', async () => {
    await enablement.set('g2', 'widgets', true);
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const ran: Array<{ step: string; guildId: string; actorId: string | null }> = [];
    const enqueue = (guildId: string, actorId: string, step: string, wait = false) =>
      dispatcher.runHandler(runtime('widgets'), guildId, actorId, 'test', (ctx) => {
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
    await keyed.runHandler(runtime('widgets'), 'g2', null, 'test', async (ctx) => {
      await ctx.queue.run('channel-1', async () => undefined);
    });
    expect(run).toHaveBeenCalledWith('widgets/g2/channel-1', expect.any(Function));
  });

  it('logs failing queued tasks on the module logger', async () => {
    await dispatcher.runHandler(runtime('widgets'), 'g1', null, 'test', (ctx) => {
      void ctx.queue.run('broken', async () => {
        throw new Error('queued failure');
      });
    });
    await dispatcher.idle();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, module: 'widgets', msg: 'Handler failed', guildId: 'g1', handler: 'queue:broken' }),
    );
  });

  it('finds the guild in the second argument when the first has none', async () => {
    const guild = Object.assign(Object.create(Guild.prototype) as Guild, { id: 'g1' });
    await dispatcher.handleDiscord(Events.MessageCreate, [{ id: 'm9', guildId: null, content: '' }, guild]);
    expect(seen.map((entry) => entry.guildId)).toEqual(['g1', 'g1']);
  });

  it('skips queued tasks of a module switched off in the guild', async () => {
    await upsertGuild(t.database.admin, 'g7');
    const ran: string[] = [];
    const queueTask = () =>
      dispatcher.runHandler(runtime('widgets'), 'g7', null, 'test', async (ctx) => {
        await ctx.queue.run('k', async () => {
          ran.push('task');
        });
      });
    await enablement.set('g7', 'widgets', false);
    await queueTask();
    expect(ran).toEqual([]);
    await enablement.set('g7', 'widgets', true);
    await queueTask();
    expect(ran).toEqual(['task']);
  });
});

describe('raw gateway events', () => {
  const packet = (guildId: string | undefined) => ({
    t: 'THREAD_DELETE',
    d: { id: 't1', guild_id: guildId, parent_id: 'f1', type: 11 },
  });

  it('lists the raw packet types modules listen to', () => {
    expect(dispatcher.gatewayEvents()).toEqual(['THREAD_DELETE']);
  });

  it('routes a raw THREAD_DELETE to listeners of enabled modules by guild_id', async () => {
    await dispatcher.handleGateway(packet('g1'));
    expect(seen).toEqual([
      { module: 'widgets', guildId: 'g1', actorId: null, detail: 't1' },
      { module: 'beta', guildId: 'g1', actorId: null, detail: 't1' },
    ]);
  });

  it('ignores packets without guild_id', async () => {
    await dispatcher.handleGateway(packet(undefined));
    expect(seen).toEqual([]);
  });

  it('skips modules disabled in the guild', async () => {
    await enablement.set('g2', 'widgets', false);
    await dispatcher.handleGateway(packet('g2'));
    expect(seen.map((entry) => entry.module)).toEqual(['beta']);
  });

  it('ignores event names no module listens to', async () => {
    await dispatcher.handleGateway({ t: 'CHANNEL_DELETE', d: { id: 'c1', guild_id: 'g1' } });
    expect(seen).toEqual([]);
  });

  it('drops packets of guilds the gate rejects', async () => {
    const gated = new Dispatcher({
      runtimes,
      database: t.database,
      enablement,
      queue: new KeyedQueue(() => undefined),
      guildGate: async () => false,
    });
    await gated.handleGateway(packet('g1'));
    expect(seen).toEqual([]);
  });
});

describe('ctx.customId', () => {
  it('signs components of its own module for the run guild and actor', async () => {
    const signing = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined), signer, now: () => 0 });
    let ids: string[] = [];
    const result = await signing.runHandler(runtime('widgets'), 'g1', 'u1', 'test', (ctx) => {
      ids = [ctx.customId(tap, ['a']), ctx.customId(own), ctx.customId(own, [], { userId: 'u2' })];
    });
    expect(result).toEqual({ ok: true });
    const target = { guildId: 'g1', userId: 'u1', channelId: null };
    expect(checkCustomId(signer, tap, ids[0]!, target, 0)).toEqual({ ok: true, args: ['a'] });
    expect(checkCustomId(signer, own, ids[1]!, target, 0).ok).toBe(true);
    expect(checkCustomId(signer, own, ids[2]!, target, 0).ok).toBe(false);
    expect(checkCustomId(signer, own, ids[2]!, { ...target, userId: 'u2' }, 0).ok).toBe(true);
  });

  it("refuses another module's components, a bound user without an actor and a missing secret", async () => {
    const signing = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined), signer });
    const foreign = await signing.runHandler(runtime('beta'), 'g1', 'u1', 'test', (ctx) => ctx.customId(tap));
    expect(foreign).toMatchObject({ ok: false, error: { message: 'Module "beta" cannot sign components of module "widgets".' } });
    const noActor = await signing.runHandler(runtime('widgets'), 'g1', null, 'test', (ctx) => ctx.customId(own));
    expect(noActor).toMatchObject({ ok: false, error: { message: expect.stringContaining('needs a user') } });
    const unsigned = await dispatcher.runHandler(runtime('widgets'), 'g1', 'u1', 'test', (ctx) => ctx.customId(tap));
    expect(unsigned).toMatchObject({ ok: false, error: { message: 'Components need interactions.secret in the config.' } });
  });
});

describe('module APIs', () => {
  const given = defineEvent<{ to: string }>('given');
  const queued: Array<{ module: string; guildId: string; actorId: string | null }> = [];
  // Named widgets so its database role owns the widget items it writes.
  const badge = defineButton({ name: 'badge', bind: { user: true }, execute: () => undefined });
  const provider = defineModule({
    name: 'widgets',
    db: { schema: widgetsSchema, migrations: widgetsMigrations },
    events: { given },
    components: [badge],
    api: (ctx) => ({
      badgeId: (id: string) => ctx.customId(badge, [id]),
      async award(to: string) {
        await ctx.db.run(async (tx) => {
          await tx.insert(widgetItems).values({ id: `award-${to}`, label: ctx.actorId ?? 'bot' });
          ctx.emit(given, { to });
        });
        return { guildId: ctx.guildId, actorId: ctx.actorId };
      },
      later(key: string) {
        return ctx.queue.run(key, async (task) => {
          queued.push({ module: task.module, guildId: task.guildId, actorId: task.actorId });
        });
      },
    }),
  });
  const caller = defineModule({ name: 'caller', dependsOn: [provider] });
  const received: Array<{ guildId: string; actorId: string | null; to: string }> = [];
  const audience = defineModule({
    name: 'audience',
    listeners: [
      on(given, (ctx, payload) => {
        received.push({ guildId: ctx.guildId, actorId: ctx.actorId, to: payload.to });
      }),
    ],
  });
  let apiRuntimes: ModuleRuntime[];
  let apiDispatcher: Dispatcher;
  const callerRuntime = () => apiRuntimes.find((candidate) => candidate.name === 'caller')!;

  beforeAll(() => {
    apiRuntimes = createModuleRuntimes(
      [provider, caller, audience].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    apiDispatcher = new Dispatcher({
      runtimes: apiRuntimes,
      database: t.database,
      enablement,
      queue: new KeyedQueue(() => undefined),
      signer,
      now: () => 0,
    });
  });

  beforeEach(() => {
    received.length = 0;
    queued.length = 0;
  });

  it("resolves an API's handler fields to the calling run", async () => {
    let awarded: unknown;
    const result = await apiDispatcher.runHandler(callerRuntime(), 'g1', 'u1', 'test', async (ctx) => {
      awarded = await ctx.modules.get(provider).award('u2');
    });
    expect(result).toEqual({ ok: true });
    expect(awarded).toEqual({ guildId: 'g1', actorId: 'u1' });
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'award-u2'));
    expect(row).toMatchObject({ guildId: 'g1', createdBy: 'u1', label: 'u1' });
    await apiDispatcher.idle();
    expect(received).toEqual([{ guildId: 'g1', actorId: 'u1', to: 'u2' }]);
  });

  it("signs the provider's components for the calling run", async () => {
    let id = '';
    await apiDispatcher.runHandler(callerRuntime(), 'g1', 'u1', 'test', (ctx) => {
      id = ctx.modules.get(provider).badgeId('b1');
    });
    expect(id).toMatch(/^widgets:badge:b1:/);
    expect(checkCustomId(signer, badge, id, { guildId: 'g1', userId: 'u1', channelId: null }, 0)).toEqual({ ok: true, args: ['b1'] });
  });

  it('runs tasks an API queues as the providing module', async () => {
    await apiDispatcher.runHandler(callerRuntime(), 'g1', 'u1', 'test', async (ctx) => {
      await ctx.modules.get(provider).later('k');
    });
    expect(queued).toEqual([{ module: 'widgets', guildId: 'g1', actorId: 'u1' }]);
  });

  it("refuses an API call after the caller's handler finished", async () => {
    let late: Promise<unknown> | undefined;
    await apiDispatcher.runHandler(callerRuntime(), 'g1', 'u1', 'test', (ctx) => {
      const api = ctx.modules.get(provider);
      late = new Promise((resolve) => {
        setTimeout(() => resolve(api.award('u3')), 10);
      });
    });
    await expect(late).rejects.toThrow('A module API was used outside a handler.');
    const rows = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'award-u3'));
    expect(rows).toEqual([]);
    await apiDispatcher.idle();
    expect(received).toEqual([]);
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

describe('gates', () => {
  const deleting = defineGate<{ id: string }>('deleting');
  const asked: string[] = [];
  let behaviour: Record<string, (payload: { id: string }) => Promise<GateVerdict | void> | GateVerdict | void>;
  const listener = (name: string) =>
    gate(deleting, async (ctx, payload) => {
      asked.push(name);
      return behaviour[name]?.(payload);
    });
  const owner = defineModule({ name: 'widgets', db: { schema: widgetsSchema, migrations: widgetsMigrations }, gates: { deleting } });
  const first = defineModule({ name: 'gate_first', dependsOn: [owner], listeners: [listener('gate_first')] });
  const second = defineModule({ name: 'gate_second', dependsOn: [owner, first], listeners: [listener('gate_second')] });
  let gateRuntimes: ModuleRuntime[];
  let gateEnablement: ModuleEnablement;
  let gateDispatcher: Dispatcher;
  const check = (guildId = 'g1') =>
    gateDispatcher.runHandler(gateRuntimes[0]!, guildId, 'u1', 'test', async (ctx) => {
      result = await ctx.check(deleting, { id: 't1' });
    });
  let result: GateResult | undefined;

  beforeAll(() => {
    gateEnablement = new ModuleEnablement(t.database.admin);
    gateRuntimes = createModuleRuntimes(
      [owner, first, second].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    gateDispatcher = new Dispatcher({
      runtimes: gateRuntimes,
      database: t.database,
      enablement: gateEnablement,
      queue: new KeyedQueue(() => undefined),
    });
  });

  beforeEach(() => {
    asked.length = 0;
    behaviour = {};
    result = undefined;
  });

  it('allows when no listener denies', async () => {
    expect((await check()).ok).toBe(true);
    expect(result).toEqual({ allowed: true });
    expect(asked).toEqual(['gate_first', 'gate_second']);
  });

  it('allows when nothing listens', async () => {
    const lone = defineGate<null>('lone');
    const quiet = defineModule({ name: 'gate_quiet', gates: { lone } });
    const [rt] = createModuleRuntimes([{ packageName: '@test/q', definition: quiet, config: {} }], {
      client: {} as Client,
      database: t.database,
      log: captureLog().log,
    });
    const d = new Dispatcher({ runtimes: [rt!], database: t.database, enablement: gateEnablement, queue: new KeyedQueue(() => undefined) });
    let answer: GateResult | undefined;
    await d.runHandler(rt!, 'g1', null, 'test', async (ctx) => {
      answer = await ctx.check(lone, null);
    });
    expect(answer).toEqual({ allowed: true });
  });

  it('passes the payload and the first denial stops later listeners', async () => {
    behaviour.gate_first = (payload) => ({ deny: `in use by ${payload.id}` });
    await check();
    expect(result).toEqual({ allowed: false, reasons: ['in use by t1'] });
    expect(asked).toEqual(['gate_first']);
  });

  it('runs listeners with the caller guild and actor', async () => {
    let seenBy: Seen | undefined;
    const probe = defineModule({
      name: 'gate_probe',
      dependsOn: [owner],
      listeners: [
        gate(deleting, (ctx) => {
          seenBy = { module: 'gate_probe', guildId: ctx.guildId, actorId: ctx.actorId, detail: null };
        }),
      ],
    });
    const rts = createModuleRuntimes(
      [owner, probe].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    const d = new Dispatcher({ runtimes: rts, database: t.database, enablement: gateEnablement, queue: new KeyedQueue(() => undefined) });
    await d.runHandler(rts[0]!, 'g2', 'u9', 'test', (ctx) => ctx.check(deleting, { id: 'x' }));
    expect(seenBy).toEqual({ module: 'gate_probe', guildId: 'g2', actorId: 'u9', detail: null });
  });

  it('a throwing listener denies with "<module> failed to answer"', async () => {
    behaviour.gate_first = () => {
      throw new Error('boom');
    };
    await check();
    expect(result).toEqual({ allowed: false, reasons: ['gate_first failed to answer'] });
    expect(asked).toEqual(['gate_first']);
  });

  it.each([[''], [42], [null], [{ reason: 'no' }]])('a verdict with deny %j denies with "<module> gave an invalid answer"', async (deny) => {
    behaviour.gate_first = () => ({ deny }) as unknown as GateVerdict;
    await check();
    expect(result).toEqual({ allowed: false, reasons: ['gate_first gave an invalid answer'] });
    expect(asked).toEqual(['gate_first']);
  });

  it.each([[false], [true], [null], ['no'], [0], [{}], [{ reason: 'no' }]])(
    'a verdict %j denies with "<module> gave an invalid answer"',
    async (verdict) => {
      behaviour.gate_first = () => verdict as unknown as GateVerdict;
      await check();
      expect(result).toEqual({ allowed: false, reasons: ['gate_first gave an invalid answer'] });
      expect(asked).toEqual(['gate_first']);
    },
  );

  it('lets an API method check its own gate for the calling handler', async () => {
    const releasing = defineGate<{ id: string }>('releasing');
    const keeper = defineModule({
      name: 'gate_keeper',
      gates: { releasing },
      api: (ctx) => ({ release: (id: string) => ctx.check(releasing, { id }) }),
    });
    const holder = defineModule({
      name: 'gate_holder',
      dependsOn: [keeper],
      listeners: [gate(releasing, (ctx, payload) => ({ deny: `${payload.id} held for ${ctx.actorId}` }))],
    });
    const user = defineModule({ name: 'gate_user', dependsOn: [keeper] });
    const rts = createModuleRuntimes(
      [keeper, holder, user].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    const d = new Dispatcher({ runtimes: rts, database: t.database, enablement: gateEnablement, queue: new KeyedQueue(() => undefined) });
    let answer: GateResult | undefined;
    const run = await d.runHandler(rts[2]!, 'g1', 'u7', 'test', async (ctx) => {
      answer = await ctx.modules.get(keeper).release('t9');
    });
    expect(run).toEqual({ ok: true });
    expect(answer).toEqual({ allowed: false, reasons: ['t9 held for u7'] });
  });

  it('a listener over 5 s denies with "<module> did not answer in time"', async () => {
    vi.useFakeTimers();
    try {
      behaviour.gate_first = () => new Promise(() => undefined);
      const done = check();
      await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS + 1);
      await done;
      expect(result).toEqual({ allowed: false, reasons: ['gate_first did not answer in time'] });
      expect(asked).toEqual(['gate_first']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips modules disabled in the guild', async () => {
    await gateEnablement.set('g2', 'gate_first', false);
    behaviour.gate_first = () => ({ deny: 'no' });
    await check('g2');
    expect(result).toEqual({ allowed: true });
    expect(asked).toEqual(['gate_second']);
  });

  it('check inside ctx.db.run throws', async () => {
    const run = await gateDispatcher.runHandler(gateRuntimes[0]!, 'g1', null, 'test', (ctx) =>
      ctx.db.run(async () => {
        await ctx.check(deleting, { id: 't1' });
      }),
    );
    expect(run.ok).toBe(false);
    expect((run as { error: Error }).error.message).toMatch(/inside ctx\.db\.run/);
    expect(asked).toEqual([]);
  });

  it('a module can only check its own gates', async () => {
    const run = await gateDispatcher.runHandler(gateRuntimes[1]!, 'g1', null, 'test', async (ctx) => {
      await ctx.check(deleting, { id: 't1' });
    });
    expect(run.ok).toBe(false);
    expect((run as { error: Error }).error.message).toMatch(/cannot check widgets\.deleting/);
    expect(asked).toEqual([]);
  });
});

describe('collectors', () => {
  const gathering = defineCollector<{ id: string }, string[]>('gathering');
  const asked: string[] = [];
  let behaviour: Record<string, (payload: { id: string }) => Promise<unknown> | unknown>;
  const listener = (name: string, ask = gathering) =>
    answer(ask, async (_ctx, payload) => {
      asked.push(name);
      return behaviour[name]?.(payload) as string[];
    });
  const owner = defineModule({ name: 'widgets', db: { schema: widgetsSchema, migrations: widgetsMigrations }, asks: { gathering } });
  const first = defineModule({ name: 'col_first', dependsOn: [owner], listeners: [listener('col_first')] });
  const second = defineModule({ name: 'col_second', dependsOn: [owner, first], listeners: [listener('col_second')] });
  let runtimes: ModuleRuntime[];
  let enablement: ModuleEnablement;
  let dispatcher: Dispatcher;
  let result: Collected<string[]>[] | undefined;
  const collect = (guildId = 'g1') =>
    dispatcher.runHandler(runtimes[0]!, guildId, 'u1', 'test', async (ctx) => {
      result = await ctx.ask(gathering, { id: 't1' });
    });

  beforeAll(() => {
    enablement = new ModuleEnablement(t.database.admin);
    runtimes = createModuleRuntimes(
      [owner, first, second].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
  });

  beforeEach(() => {
    asked.length = 0;
    behaviour = {};
    result = undefined;
  });

  it('gathers answers in module order', async () => {
    behaviour.col_first = () => ['a'];
    behaviour.col_second = (payload) => [payload.id];
    await collect();
    expect(result).toEqual([
      { module: 'col_first', value: ['a'] },
      { module: 'col_second', value: ['t1'] },
    ]);
  });

  it('skips a throwing listener and asks the rest', async () => {
    behaviour.col_first = () => {
      throw new Error('boom');
    };
    behaviour.col_second = () => ['b'];
    await collect();
    expect(result).toEqual([{ module: 'col_second', value: ['b'] }]);
    expect(asked).toEqual(['col_first', 'col_second']);
  });

  it('skips a listener that times out', async () => {
    vi.useFakeTimers();
    try {
      behaviour.col_first = () => new Promise(() => undefined);
      behaviour.col_second = () => ['b'];
      const done = collect();
      await vi.advanceTimersByTimeAsync(COLLECTOR_TIMEOUT_MS + 1);
      await done;
      expect(result).toEqual([{ module: 'col_second', value: ['b'] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late answer', async () => {
    vi.useFakeTimers();
    try {
      behaviour.col_first = () => new Promise((resolve) => setTimeout(() => resolve(['late']), COLLECTOR_TIMEOUT_MS + 100));
      behaviour.col_second = () => ['b'];
      const done = collect();
      await vi.advanceTimersByTimeAsync(COLLECTOR_TIMEOUT_MS + 1);
      await done;
      const returned = result;
      await vi.advanceTimersByTimeAsync(1000);
      expect(result).toBe(returned);
      expect(result).toHaveLength(1);
      expect(result).toEqual([{ module: 'col_second', value: ['b'] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips invalid answers', async () => {
    const checked = defineCollector<null, string[]>('checked', { validate: Array.isArray as (value: unknown) => value is string[] });
    const checkedOwner = defineModule({ name: 'col_owner', asks: { checked } });
    const bad = defineModule({ name: 'col_bad', dependsOn: [checkedOwner], listeners: [answer(checked, () => 'nope' as unknown as string[])] });
    const good = defineModule({ name: 'col_good', dependsOn: [checkedOwner, bad], listeners: [answer(checked, () => ['ok'])] });
    const log = captureLog();
    const rts = createModuleRuntimes(
      [checkedOwner, bad, good].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: log.log },
    );
    const d = new Dispatcher({ runtimes: rts, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
    let got: Collected<string[]>[] | undefined;
    await d.runHandler(rts[0]!, 'g1', null, 'test', async (ctx) => {
      got = await ctx.ask(checked, null);
    });
    expect(got).toEqual([{ module: 'col_good', value: ['ok'] }]);
    expect(JSON.stringify(log.lines)).toContain('Ask listener gave an invalid answer');
  });

  it('skips a listener whose answer makes the validator throw', async () => {
    const strict = defineCollector<null, string>('strict', {
      validate: (value): value is string => {
        if (value === 'explode') throw new Error('validator boom');
        return typeof value === 'string';
      },
    });
    const strictOwner = defineModule({ name: 'col_strict_owner', asks: { strict } });
    const bomb = defineModule({ name: 'col_bomb', dependsOn: [strictOwner], listeners: [answer(strict, () => 'explode')] });
    const fine = defineModule({ name: 'col_fine', dependsOn: [strictOwner, bomb], listeners: [answer(strict, () => 'fine')] });
    const log = captureLog();
    const rts = createModuleRuntimes(
      [strictOwner, bomb, fine].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: log.log },
    );
    const d = new Dispatcher({ runtimes: rts, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
    let got: Collected<string>[] | undefined;
    await d.runHandler(rts[0]!, 'g1', null, 'test', async (ctx) => {
      got = await ctx.ask(strict, null);
    });
    expect(got).toEqual([{ module: 'col_fine', value: 'fine' }]);
    expect(JSON.stringify(log.lines)).toContain('Ask listener gave an invalid answer');
    expect(JSON.stringify(log.lines)).toContain('validator boom');
  });

  it('skips disabled modules', async () => {
    await enablement.set('g1', 'col_first', false);
    try {
      behaviour.col_first = () => ['a'];
      behaviour.col_second = () => ['b'];
      await collect();
      expect(result).toEqual([{ module: 'col_second', value: ['b'] }]);
      expect(asked).toEqual(['col_second']);
    } finally {
      await enablement.set('g1', 'col_first', true);
    }
  });

  it('honours a custom timeoutMs', async () => {
    const quick = defineCollector<null, string>('quick', { timeoutMs: 50 });
    const quickOwner = defineModule({ name: 'col_quick_owner', asks: { quick } });
    const slow = defineModule({
      name: 'col_slow',
      dependsOn: [quickOwner],
      listeners: [answer(quick, async () => (await new Promise((r) => setTimeout(r, 100)), 'slow'))],
    });
    const fast = defineModule({ name: 'col_fast', dependsOn: [quickOwner, slow], listeners: [answer(quick, () => 'fast')] });
    const rts = createModuleRuntimes(
      [quickOwner, slow, fast].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
      { client: {} as Client, database: t.database, log: captureLog().log },
    );
    const d = new Dispatcher({ runtimes: rts, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
    let got: Collected<string>[] | undefined;
    await d.runHandler(rts[0]!, 'g1', null, 'test', async (ctx) => {
      got = await ctx.ask(quick, null);
    });
    expect(got).toEqual([{ module: 'col_fast', value: 'fast' }]);
  });

  describe('ctx.ask guards', () => {
    it('a module can only ask its own asks', async () => {
      const run = await dispatcher.runHandler(runtimes[1]!, 'g1', null, 'test', async (ctx) => {
        await ctx.ask(gathering, { id: 't1' });
      });
      expect(run.ok).toBe(false);
      expect((run as { error: Error }).error.message).toBe(
        'Module "col_first" cannot ask widgets.gathering; modules ask only their own asks.',
      );
      expect(asked).toEqual([]);
    });

    it('asking inside ctx.db.run throws', async () => {
      const run = await dispatcher.runHandler(runtimes[0]!, 'g1', null, 'test', (ctx) =>
        ctx.db.run(async () => {
          await ctx.ask(gathering, { id: 't1' });
        }),
      );
      expect(run.ok).toBe(false);
      expect((run as { error: Error }).error.message).toBe(
        'Module "widgets" asked widgets.gathering inside ctx.db.run; ask before opening the transaction.',
      );
      expect(asked).toEqual([]);
    });

    it('asking after the handler finished throws', async () => {
      let late: HandlerContext | undefined;
      await dispatcher.runHandler(runtimes[0]!, 'g1', null, 'test', (ctx) => {
        late = ctx;
      });
      expect(() => late!.ask(gathering, { id: 't1' })).toThrow(
        'Module "widgets" asked widgets.gathering after its handler finished; ask inside the handler or a queued task.',
      );
      expect(asked).toEqual([]);
    });
  });
});
