import type { Client } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markGuildLeft, upsertGuild } from '../src/db/guilds.js';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { coreEvents, on } from '../src/runtime/events.js';
import { GuildLifecycle } from '../src/runtime/lifecycle.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { captureLog } from './log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-14T12:00:00Z');
let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterEach(async () => {
  await t.drop();
});

interface Options {
  failCleanupFor?: string;
  onAlphaCleanup?: (guildId: string) => Promise<void>;
}

function build(options: Options = {}) {
  const calls: string[] = [];
  const alpha = defineModule({
    name: 'alpha',
    hooks: {
      guildReady: (ctx) => {
        calls.push(`alpha:ready:${ctx.guildId}`);
      },
      deleteGuildData: async (_ctx, guildId) => {
        calls.push(`alpha:cleanup:${guildId}`);
        await options.onAlphaCleanup?.(guildId);
      },
    },
    listeners: [
      on(coreEvents.guildJoined, (ctx) => {
        calls.push(`alpha:joined:${ctx.guildId}`);
      }),
      on(coreEvents.guildLeft, (ctx) => {
        calls.push(`alpha:left:${ctx.guildId}`);
      }),
    ],
  });
  const beta = defineModule({
    name: 'beta',
    dependsOn: [alpha],
    hooks: {
      guildReady: (ctx) => {
        calls.push(`beta:ready:${ctx.guildId}`);
      },
      deleteGuildData: (_ctx, guildId) => {
        calls.push(`beta:cleanup:${guildId}`);
        if (guildId === options.failCleanupFor) throw new Error('cleanup failed');
      },
    },
  });
  const enablement = new ModuleEnablement(t.database.admin);
  const runtimes = createModuleRuntimes(
    [alpha, beta].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
    { client: {} as Client, database: t.database, log: captureLog().log, queue: new KeyedQueue(() => undefined) },
  );
  const dispatcher = new Dispatcher({ runtimes, database: t.database, enablement });
  const lifecycle = new GuildLifecycle({ runtimes, dispatcher, enablement, database: t.database });
  return { calls, enablement, dispatcher, lifecycle };
}

async function guildRow(id: string) {
  const [row] = await t.database.admin.select().from(guilds).where(eq(guilds.id, id));
  return row;
}

async function leaveAgo(id: string, days: number): Promise<void> {
  await upsertGuild(t.database.admin, id);
  await markGuildLeft(t.database.admin, id, new Date(NOW.getTime() - days * DAY));
}

describe('GuildLifecycle', () => {
  it('registers a guild and runs guildReady for each module in dependency order', async () => {
    const { calls, lifecycle } = build();
    await lifecycle.setUp('g1', false);
    expect(await guildRow('g1')).toBeDefined();
    expect(calls).toEqual(['alpha:ready:g1', 'beta:ready:g1']);
  });

  it('skips guildReady of modules switched off in the guild', async () => {
    const { calls, enablement, lifecycle } = build();
    await upsertGuild(t.database.admin, 'g1');
    await enablement.set('g1', 'beta', false);
    await lifecycle.setUp('g1', false);
    expect(calls).toEqual(['alpha:ready:g1']);
  });

  it('sets a guild up once until it is forgotten', async () => {
    const { calls, lifecycle } = build();
    await lifecycle.setUp('g1', false);
    await lifecycle.setUp('g1', false);
    expect(calls).toEqual(['alpha:ready:g1', 'beta:ready:g1']);
    lifecycle.forget('g1');
    await lifecycle.setUp('g1', false);
    expect(calls).toEqual(['alpha:ready:g1', 'beta:ready:g1', 'alpha:ready:g1', 'beta:ready:g1']);
  });

  it('lets a second set-up of the same guild wait for the first', async () => {
    const { calls, lifecycle } = build();
    const first = lifecycle.setUp('g8', false);
    await lifecycle.setUp('g8', false);
    expect(await guildRow('g8')).toBeDefined();
    await first;
    expect(calls).toEqual(['alpha:ready:g8', 'beta:ready:g8']);
  });

  it('announces joins, but not guilds that were already there', async () => {
    const { calls, dispatcher, lifecycle } = build();
    await lifecycle.setUp('joined', true);
    await lifecycle.setUp('existing', false);
    await dispatcher.idle();
    expect(calls).toContain('alpha:joined:joined');
    expect(calls).not.toContain('alpha:joined:existing');
  });

  it('records leaving and sets the guild up again when it returns', async () => {
    const { calls, dispatcher, lifecycle } = build();
    await lifecycle.setUp('g4', false);
    await lifecycle.leave('g4', NOW);
    await dispatcher.idle();
    expect((await guildRow('g4'))?.leftAt).toEqual(NOW);
    expect(calls).toContain('alpha:left:g4');
    calls.length = 0;
    await lifecycle.setUp('g4', false);
    expect((await guildRow('g4'))?.leftAt).toBeNull();
    expect(calls).toEqual(['alpha:ready:g4', 'beta:ready:g4']);
  });

  it('deletes guilds past their grace period after every module cleaned up', async () => {
    const { calls, lifecycle } = build();
    await leaveAgo('old', 31);
    await leaveAgo('recent', 1);
    expect(await lifecycle.purgeDueGuilds(NOW)).toEqual(['old']);
    expect(calls).toEqual(['beta:cleanup:old', 'alpha:cleanup:old']);
    expect(await guildRow('old')).toBeUndefined();
    expect(await guildRow('recent')).toBeDefined();
  });

  it('keeps a guild whose cleanup failed for the next run', async () => {
    const { calls, lifecycle } = build({ failCleanupFor: 'stubborn' });
    await leaveAgo('stubborn', 31);
    expect(await lifecycle.purgeDueGuilds(NOW)).toEqual([]);
    expect(calls).toEqual(['beta:cleanup:stubborn', 'alpha:cleanup:stubborn']);
    expect(await guildRow('stubborn')).toBeDefined();
  });

  it('keeps a guild that came back while the purge was running', async () => {
    const { calls, lifecycle } = build({
      onAlphaCleanup: async (guildId) => {
        if (guildId === 'a-first') await upsertGuild(t.database.admin, 'b-back');
      },
    });
    await leaveAgo('a-first', 31);
    await leaveAgo('b-back', 31);
    expect(await lifecycle.purgeDueGuilds(NOW)).toEqual(['a-first']);
    expect(calls).not.toContain('beta:cleanup:b-back');
    expect((await guildRow('b-back'))?.leftAt).toBeNull();
  });

  it('deletes one guild on request after its cleanup', async () => {
    const { calls, lifecycle } = build();
    await upsertGuild(t.database.admin, 'g5');
    await lifecycle.deleteGuild('g5');
    expect(calls).toEqual(['beta:cleanup:g5', 'alpha:cleanup:g5']);
    expect(await guildRow('g5')).toBeUndefined();
  });

  it('keeps the guild when a cleanup fails on request', async () => {
    const { lifecycle } = build({ failCleanupFor: 'g6' });
    await upsertGuild(t.database.admin, 'g6');
    await expect(lifecycle.deleteGuild('g6')).rejects.toThrow('Cleanup failed for guild g6; its data was kept.');
    expect(await guildRow('g6')).toBeDefined();
  });
});
