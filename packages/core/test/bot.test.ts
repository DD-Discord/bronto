import { Events } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/config/errors.js';
import { defineCommand } from '../src/interactions/commands.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { markGuildLeft, upsertGuild } from '../src/db/guilds.js';
import { guildModules, guilds } from '../src/db/schema.js';
import { createBot, StartupError, type Bot } from '../src/runtime/bot.js';
import { coreEvents, on } from '../src/runtime/events.js';
import type { ModuleDefinition } from '../src/runtime/module.js';
import { FakeClient } from '../src/testing/fake-client.js';
import { fakeCommand } from '../src/testing/interactions.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { captureLog } from '../src/testing/log.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

let t: TestDatabase;
const bots: Bot[] = [];

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
  await t.drop();
});

function makeBot(modules: ModuleDefinition[], database: Database = t.database, purgeIntervalMs?: number) {
  const client = new FakeClient();
  const { log, lines } = captureLog();
  const bot = createBot({
    config: { discord: { token: 'token-1' }, database: { appUrl: t.appUrl, adminUrl: t.adminUrl }, modules: {} },
    modules: modules.map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
    database,
    client: client.asClient(),
    log,
    purgeIntervalMs,
  });
  bots.push(bot);
  return { bot, client, lines };
}

/** Widgets with a /widgets command and recorded guildReady calls. */
function commandWidgets(calls: string[]): ModuleDefinition {
  return widgetsModule({
    commands: {
      widgets: defineCommand({
        description: 'Widgets',
        execute: async (ctx) => {
          await ctx.reply(`widgets in ${ctx.guildId} for ${ctx.actorId}`);
        },
      }),
    },
    hooks: {
      guildReady: (ctx) => {
        calls.push(`ready:${ctx.guildId}`);
      },
    },
  });
}

const commandNames = (client: FakeClient, guildId: string) =>
  (client.registered.get(guildId) as Array<{ name: string }> | undefined)?.map((command) => command.name);

function recordingWidgets(calls: string[]): ModuleDefinition {
  return widgetsModule({
    hooks: {
      start: () => {
        calls.push('start');
      },
      guildReady: (ctx) => {
        calls.push(`ready:${ctx.guildId}`);
      },
    },
    listeners: [
      on(Events.MessageCreate, async (ctx, message) => {
        await ctx.db.run(async (tx) => {
          await tx.insert(widgetItems).values({ id: message.id, label: 'from a message' });
        });
      }),
      on(coreEvents.guildJoined, (ctx) => {
        calls.push(`joined:${ctx.guildId}`);
      }),
    ],
  });
}

/** Emits ClientReady and waits for the startup work, as discord.js does before most guild events. */
async function ready(bot: Bot, client: FakeClient): Promise<void> {
  client.emit(Events.ClientReady, client);
  await bot.idle();
}

/** Adds a guild to the client cache, where discord.js keeps every guild it was sent. */
function cache(client: FakeClient, id: string, available = true): void {
  client.guilds.cache.set(id, { id, available });
}

async function schemaExists(name: string): Promise<boolean> {
  const { rows } = await t.database.adminPool.query('select 1 from pg_namespace where nspname = $1', [name]);
  return rows.length === 1;
}

describe('createBot', () => {
  it('prepares the database before logging in', async () => {
    const { bot, client } = makeBot([widgetsModule()]);
    await bot.start();
    expect(await schemaExists('widgets')).toBe(true);
    expect(client.loggedInWith).toBe('token-1');
  });

  it('refuses to start when the app role is the admin role', async () => {
    const unsafe = createDatabase({ adminUrl: t.adminUrl, appUrl: t.adminUrl });
    try {
      const { bot, client } = makeBot([], unsafe);
      const error = await bot.start().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StartupError);
      expect((error as StartupError).problems.join('\n')).toMatch(/is the admin role/);
      expect(client.loggedInWith).toBeNull();
    } finally {
      await unsafe.end();
    }
  });

  it('runs start hooks and sets up cached guilds once the client is ready', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    client.guilds.cache.set('g1', { id: 'g1', available: true });
    await bot.start();
    client.emit(Events.ClientReady, client);
    await bot.idle();
    expect(calls).toEqual(['start', 'ready:g1']);
    expect(await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g1'))).toHaveLength(1);
    client.emit(Events.GuildAvailable, { id: 'g1' });
    await bot.idle();
    expect(calls).toEqual(['start', 'ready:g1']);
  });

  it('sets a guild up again after it was unavailable', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    await ready(bot, client);
    cache(client, 'g7');
    client.emit(Events.GuildAvailable, { id: 'g7' });
    await bot.idle();
    client.emit(Events.GuildUnavailable, { id: 'g7' });
    client.emit(Events.GuildAvailable, { id: 'g7' });
    await bot.idle();
    expect(calls).toEqual(['start', 'ready:g7', 'ready:g7']);
  });

  it('announces joins and runs module listeners for gateway events', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    await ready(bot, client);
    cache(client, 'g2');
    client.emit(Events.GuildCreate, { id: 'g2' });
    await bot.idle();
    expect([...calls].sort()).toEqual(['joined:g2', 'ready:g2', 'start']);
    client.emit(Events.MessageCreate, { id: 'm1', guildId: 'g2' });
    await bot.idle();
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'm1'));
    expect(row?.guildId).toBe('g2');
  });

  it('records guilds the bot was removed from', async () => {
    const { bot, client } = makeBot([recordingWidgets([])]);
    await bot.start();
    await ready(bot, client);
    cache(client, 'g3');
    client.emit(Events.GuildAvailable, { id: 'g3' });
    await bot.idle();
    client.emit(Events.GuildDelete, { id: 'g3' });
    await bot.idle();
    const [row] = await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g3'));
    expect(row?.leftAt).toBeInstanceOf(Date);
  });

  it('warns about schemas of modules that are no longer loaded', async () => {
    await makeBot([widgetsModule()]).bot.prepare();
    const { bot, lines } = makeBot([]);
    await bot.prepare();
    expect(lines).toContainEqual(expect.objectContaining({ level: 40, module: 'widgets' }));
    expect(await schemaExists('widgets')).toBe(true);
  });

  it('disconnects on stop', async () => {
    const { bot, client } = makeBot([widgetsModule()]);
    await bot.start();
    await bot.stop();
    expect(client.destroyed).toBe(true);
  });

  it('removes its gateway listeners on stop', async () => {
    const { bot, client } = makeBot([recordingWidgets([])]);
    await bot.start();
    expect(client.listenerCount(Events.MessageCreate)).toBe(1);
    await bot.stop();
    expect(client.eventNames()).toEqual([]);
  });

  it('sets up guilds announced before the client is ready only after the start hooks', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    cache(client, 'g1');
    client.emit(Events.GuildAvailable, { id: 'g1' });
    await new Promise((done) => setTimeout(done, 50));
    expect(calls).toEqual([]);
    await ready(bot, client);
    expect(calls).toEqual(['start', 'ready:g1']);
  });

  it('runs gateway events of a guild only after it is set up', async () => {
    const { bot, client } = makeBot([recordingWidgets([])]);
    await bot.prepare();
    await upsertGuild(t.database.admin, 'g5');
    await t.database.admin.insert(guildModules).values({ guildId: 'g5', module: 'widgets', enabled: false });
    await bot.start();
    cache(client, 'g5');
    await ready(bot, client);
    bot.lifecycle.forget('g5');
    client.emit(Events.GuildAvailable, { id: 'g5' });
    client.emit(Events.MessageCreate, { id: 'm5', guildId: 'g5' });
    await bot.idle();
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'm5'))).toEqual([]);
  });

  it('runs no handlers for a guild whose set-up failed and logs why', async () => {
    const { bot, client, lines } = makeBot([recordingWidgets([])]);
    await bot.start();
    await ready(bot, client);
    vi.spyOn(bot.enablement, 'load').mockRejectedValue(new Error('database down'));
    cache(client, 'g6');
    client.emit(Events.MessageCreate, { id: 'm6', guildId: 'g6' });
    await bot.idle();
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'm6'))).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: 'Setting up guild g6 failed' }));
  });

  it('logs gateway events that could not be dispatched', async () => {
    const { bot, client, lines } = makeBot([recordingWidgets([])]);
    await bot.start();
    await ready(bot, client);
    cache(client, 'g8');
    client.emit(Events.GuildAvailable, { id: 'g8' });
    await bot.idle();
    vi.spyOn(bot.enablement, 'isEnabled').mockImplementation(() => {
      throw new Error('broken switch');
    });
    client.emit(Events.MessageCreate, { id: 'm8', guildId: 'g8' });
    await bot.idle();
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: 'Dispatching messageCreate failed' }));
  });

  it('records guilds the bot was removed from while it was offline', async () => {
    const { bot, client } = makeBot([recordingWidgets([])]);
    await bot.prepare();
    for (const id of ['kept', 'outage', 'removed']) await upsertGuild(t.database.admin, id);
    cache(client, 'kept');
    cache(client, 'outage', false);
    await bot.start();
    await ready(bot, client);
    const rows = await t.database.admin.select().from(guilds);
    const leftAtOf = (id: string) => rows.find((row) => row.id === id)?.leftAt;
    expect(leftAtOf('removed')).toBeInstanceOf(Date);
    expect(leftAtOf('kept')).toBeNull();
    expect(leftAtOf('outage')).toBeNull();
  });

  it('attaches the gateway listeners only once when started again', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    await bot.start();
    await ready(bot, client);
    cache(client, 'g9');
    client.emit(Events.GuildAvailable, { id: 'g9' });
    await bot.idle();
    expect(calls).toEqual(['start', 'ready:g9']);
  });

  it('purges guilds past their grace period when ready and then on a schedule', async () => {
    const cleaned: string[] = [];
    const module = widgetsModule({ hooks: { deleteGuildData: (_ctx, guildId) => { cleaned.push(guildId); } } });
    const { bot, client } = makeBot([module], t.database, 20);
    await bot.prepare();
    await upsertGuild(t.database.admin, 'gone-1');
    await markGuildLeft(t.database.admin, 'gone-1', new Date(Date.now() - 31 * 86_400_000));
    await bot.start();
    client.emit(Events.ClientReady, client);
    await bot.idle();
    expect(cleaned).toEqual(['gone-1']);
    await upsertGuild(t.database.admin, 'gone-2');
    await markGuildLeft(t.database.admin, 'gone-2', new Date(Date.now() - 31 * 86_400_000));
    await vi.waitFor(() => expect(cleaned).toEqual(['gone-1', 'gone-2']), { timeout: 2_000 });
  });

  it('never runs purges concurrently when one outlasts the interval', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let calls = 0;
    const module = widgetsModule({
      hooks: { deleteGuildData: async () => { calls += 1; await gate; } },
    });
    const { bot, client } = makeBot([module], t.database, 20);
    await bot.prepare();
    await upsertGuild(t.database.admin, 'slow-1');
    await markGuildLeft(t.database.admin, 'slow-1', new Date(Date.now() - 31 * 86_400_000));
    await bot.start();
    client.emit(Events.ClientReady, client);
    try {
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2_000 });
      await new Promise((done) => setTimeout(done, 100));
      expect(calls).toBe(1);
    } finally {
      release();
    }
    await bot.idle();
    await vi.waitFor(async () => {
      const rows = await t.database.admin.select().from(guilds).where(eq(guilds.id, 'slow-1'));
      expect(rows).toEqual([]);
    }, { timeout: 2_000 });
    expect(calls).toBe(1);
  });

  it('does not schedule purges when stopped while starting up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const cleaned: string[] = [];
    const module = widgetsModule({
      hooks: {
        start: () => gate,
        deleteGuildData: (_ctx, guildId) => { cleaned.push(guildId); },
      },
    });
    const { bot, client } = makeBot([module], t.database, 20);
    await bot.prepare();
    await upsertGuild(t.database.admin, 'gone-3');
    await markGuildLeft(t.database.admin, 'gone-3', new Date(Date.now() - 31 * 86_400_000));
    await bot.start();
    client.emit(Events.ClientReady, client);
    const stopping = bot.stop();
    release();
    await stopping;
    await new Promise((done) => setTimeout(done, 100));
    expect(cleaned).toEqual([]);
  });

  it('registers core and module commands when a guild is set up, and only once', async () => {
    const { bot, client } = makeBot([commandWidgets([])]);
    cache(client, 'g1');
    await bot.start();
    await ready(bot, client);
    expect(commandNames(client, 'g1')).toEqual(['modules', 'widgets']);
    expect(client.commandWrites).toHaveLength(1);
    bot.lifecycle.forget('g1');
    client.emit(Events.GuildAvailable, { id: 'g1' });
    await bot.idle();
    expect(client.commandWrites).toHaveLength(1);
  });

  it('answers commands once their guild is set up', async () => {
    const { bot, client } = makeBot([commandWidgets([])]);
    await bot.start();
    await ready(bot, client);
    const fake = fakeCommand({ command: 'widgets', guildId: 'g2', userId: 'u7' });
    client.emit(Events.InteractionCreate, fake);
    await bot.idle();
    expect(fake.responses).toEqual([
      { kind: 'reply', payload: { content: 'widgets in g2 for u7', allowedMentions: { parse: [] } } },
    ]);
  });

  it('removes and restores module commands with /modules and runs guildReady on enable', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([commandWidgets(calls)]);
    cache(client, 'g1');
    await bot.start();
    await ready(bot, client);
    const say = async (subcommand: string) => {
      client.emit(Events.InteractionCreate, fakeCommand({ command: 'modules', subcommand, options: { module: 'widgets' } }));
      await bot.idle();
    };
    await say('disable');
    expect(commandNames(client, 'g1')).toEqual(['modules']);
    await say('enable');
    expect(commandNames(client, 'g1')).toEqual(['modules', 'widgets']);
    expect(calls).toEqual(['ready:g1', 'ready:g1']);
  });

  it('refuses two modules defining the same command', () => {
    const clash = defineCommand({ description: 'Clash', execute: () => undefined });
    const other = widgetsModule({ name: 'gadgets', db: undefined, commands: { widgets: clash } });
    expect(() => makeBot([commandWidgets([]), other])).toThrow(ConfigError);
  });
});
