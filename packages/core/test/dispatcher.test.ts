import { Collection, Events, Guild, type Client } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes, type ModuleRuntime } from '../src/runtime/context.js';
import { Dispatcher, guildIdOf } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { defineEvent, on } from '../src/runtime/events.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { captureLog, type LogLine } from './log.js';
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
    { client: {} as Client, database: t.database, log: captured.log, queue: new KeyedQueue(() => undefined) },
  );
  dispatcher = new Dispatcher({ runtimes, database: t.database, enablement });
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
    const ok = await dispatcher.runHandler(runtime('alpha'), 'g1', 'u1', 'test', (ctx) => {
      ctx.emit(counted, { n: 1 });
    });
    expect(ok).toBe(true);
    await dispatcher.idle();
    expect(seen).toEqual([{ module: 'beta', guildId: 'g1', actorId: 'u1', detail: 1 }]);
  });

  it('drops emitted events when the handler fails afterwards', async () => {
    const ok = await dispatcher.runHandler(runtime('alpha'), 'g1', null, 'test', (ctx) => {
      ctx.emit(counted, { n: 2 });
      throw new Error('late failure');
    });
    expect(ok).toBe(false);
    await dispatcher.idle();
    expect(seen).toEqual([]);
  });

  it("refuses to emit another module's event", async () => {
    const ok = await dispatcher.runHandler(runtime('beta'), 'g1', null, 'test', (ctx) => {
      ctx.emit(counted, { n: 3 });
    });
    expect(ok).toBe(false);
    await dispatcher.idle();
    expect(seen).toEqual([]);
    const failure = lines.find((line) => line.module === 'beta' && line.msg === 'Handler failed');
    expect((failure?.err as { message: string }).message).toMatch(/cannot emit alpha\.counted/);
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
