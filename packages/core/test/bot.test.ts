import { Events } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../src/db/database.js';
import { markGuildLeft, upsertGuild } from '../src/db/guilds.js';
import { guilds } from '../src/db/schema.js';
import { createBot, StartupError, type Bot } from '../src/runtime/bot.js';
import { coreEvents, on } from '../src/runtime/events.js';
import type { ModuleDefinition } from '../src/runtime/module.js';
import { FakeClient } from './fake-client.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { captureLog } from './log.js';
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
    client.emit(Events.GuildAvailable, { id: 'g7' });
    await bot.idle();
    client.emit(Events.GuildUnavailable, { id: 'g7' });
    client.emit(Events.GuildAvailable, { id: 'g7' });
    await bot.idle();
    expect(calls).toEqual(['ready:g7', 'ready:g7']);
  });

  it('announces joins and runs module listeners for gateway events', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    client.emit(Events.GuildCreate, { id: 'g2' });
    await bot.idle();
    expect([...calls].sort()).toEqual(['joined:g2', 'ready:g2']);
    client.emit(Events.MessageCreate, { id: 'm1', guildId: 'g2' });
    await bot.idle();
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'm1'));
    expect(row?.guildId).toBe('g2');
  });

  it('records guilds the bot was removed from', async () => {
    const { bot, client } = makeBot([recordingWidgets([])]);
    await bot.start();
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

  it('attaches the gateway listeners only once when started again', async () => {
    const calls: string[] = [];
    const { bot, client } = makeBot([recordingWidgets(calls)]);
    await bot.start();
    await bot.start();
    client.emit(Events.GuildAvailable, { id: 'g9' });
    await bot.idle();
    expect(calls).toEqual(['ready:g9']);
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
});
