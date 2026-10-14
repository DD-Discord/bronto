import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInScope } from '../src/db/context.js';
import { upsertGuild } from '../src/db/guilds.js';
import { guildModules } from '../src/db/schema.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;

async function row(guildId: string, module: string) {
  const [found] = await t.database.admin
    .select()
    .from(guildModules)
    .where(and(eq(guildModules.guildId, guildId), eq(guildModules.module, module)));
  return found;
}

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await upsertGuild(t.database.admin, 'g1');
  await upsertGuild(t.database.admin, 'g2');
});

afterAll(async () => {
  await t.drop();
});

describe('ModuleEnablement', () => {
  it('treats modules as enabled until they are switched off', () => {
    expect(new ModuleEnablement(t.database.admin).isEnabled('g1', 'alpha')).toBe(true);
  });

  it('stores a switch and reads it back after loading', async () => {
    await new ModuleEnablement(t.database.admin).set('g1', 'alpha', false);
    const fresh = new ModuleEnablement(t.database.admin);
    expect(fresh.isEnabled('g1', 'alpha')).toBe(true);
    await fresh.load('g1');
    expect(fresh.isEnabled('g1', 'alpha')).toBe(false);
  });

  it('switches a module back on', async () => {
    const enablement = new ModuleEnablement(t.database.admin);
    await enablement.set('g1', 'beta', false);
    await enablement.set('g1', 'beta', true);
    expect(enablement.isEnabled('g1', 'beta')).toBe(true);
    expect((await row('g1', 'beta'))?.enabled).toBe(true);
  });

  it('keeps guilds apart', async () => {
    const enablement = new ModuleEnablement(t.database.admin);
    await enablement.set('g2', 'gamma', false);
    await enablement.load('g1');
    expect(enablement.isEnabled('g1', 'gamma')).toBe(true);
    expect(enablement.isEnabled('g2', 'gamma')).toBe(false);
  });

  it('forgets a guild until it is loaded again', async () => {
    const enablement = new ModuleEnablement(t.database.admin);
    await enablement.set('g2', 'delta', false);
    enablement.forget('g2');
    expect(enablement.isEnabled('g2', 'delta')).toBe(true);
    await enablement.load('g2');
    expect(enablement.isEnabled('g2', 'delta')).toBe(false);
  });

  it('records who switched a module', async () => {
    await runInScope({ actorId: 'u1' }, async () => {
      await new ModuleEnablement(t.database.admin).set('g1', 'epsilon', false);
    });
    expect((await row('g1', 'epsilon'))?.updatedBy).toBe('u1');
  });
});
